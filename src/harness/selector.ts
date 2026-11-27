import { defaultOptions, type TournamentFormat } from '../config.ts'
import { completeJson } from '../llm.ts'
import { compareImagePrompt, compareTextPrompt, JUDGE_SYSTEM } from '../prompts.ts'
import type { Run } from '../trace.ts'
import { type Compare, CompareSchema, type Concept, type Match } from '../types.ts'

// Pairwise judging beats absolute 1-10 scores: models are far more reliable at
// "which of these two" than at calibrated numbers. Each match is judged twice with
// A and B swapped; if the verdict flips, the judge was reacting to order, not content.

export type Contender = { concept: Concept; imageUrl?: string }
type Judged = Match & { confidence: number }

export async function judgePair(brief: string, a: Contender, b: Contender, round: string, run?: Run): Promise<Judged> {
  const ask = (x: Contender, y: Contender): Promise<Compare> => {
    const images = x.imageUrl && y.imageUrl ? [x.imageUrl, y.imageUrl] : undefined
    return completeJson(
      {
        task: 'selector.compare',
        system: JUDGE_SYSTEM,
        prompt: images ? compareImagePrompt(brief, x.concept, y.concept) : compareTextPrompt(brief, x.concept, y.concept),
        imageUrls: images,
        temperature: 0.2,
        maxTokens: 400,
      },
      CompareSchema,
      run,
    )
  }

  const [fwdR, revR] = await Promise.allSettled([ask(a, b), ask(b, a)])
  const fwd = fwdR.status === 'fulfilled' ? fwdR.value : undefined
  const rev = revR.status === 'fulfilled' ? revR.value : undefined
  if (!fwd && !rev) throw (fwdR as PromiseRejectedResult).reason

  const fwdWinner = fwd ? (fwd.winner === 'A' ? a : b) : undefined
  const revWinner = rev ? (rev.winner === 'A' ? b : a) : undefined
  const base = { round, a: a.concept.id, b: b.concept.id }

  // One pass failed: use the other, but mark it unchecked for order bias.
  if (!fwd || !rev) {
    const only = (fwd ?? rev)!
    const w = (fwdWinner ?? revWinner)!
    return { ...base, winner: w.concept.id, reason: only.reason, consistent: false, confidence: only.confidence / 2 }
  }

  const consistent = fwdWinner === revWinner
  // On disagreement, trust whichever pass was more confident.
  const useFwd = consistent || fwd.confidence >= rev.confidence
  return {
    ...base,
    winner: (useFwd ? fwdWinner : revWinner)!.concept.id,
    reason: useFwd ? fwd.reason : rev.reason,
    consistent,
    confidence: consistent ? (fwd.confidence + rev.confidence) / 2 : Math.max(fwd.confidence, rev.confidence) / 2,
  }
}

export type TournamentSettings = { format?: TournamentFormat; roundRobinMax?: number }

/** Resolve 'auto' for a field of n contenders. Fields of 3 or fewer always get round-robin: Swiss saves nothing there. */
export function resolveFormat(n: number, { format = defaultOptions.tournament, roundRobinMax = defaultOptions.roundRobinMax }: TournamentSettings = {}): 'round-robin' | 'swiss' {
  if (n <= 3) return 'round-robin'
  if (format === 'auto') return n <= roundRobinMax ? 'round-robin' : 'swiss'
  return format
}

/**
 * Rank a field by pairwise judgement.
 * - Round-robin: every pair is judged once (n(n-1)/2 matches), so every pair is decided directly.
 * - Swiss: log2(n) rounds pairing neighbours in the standings (about n log n / 2 matches). Odd fields
 *   give the bye to the lowest-ranked contender without one, scored as a win (standard Swiss).
 * The format comes from `settings` (see resolveFormat). Ties break on head-to-head result, then on judge confidence.
 */
export async function tournament(
  brief: string,
  field: Contender[],
  label: string,
  run?: Run,
  settings: TournamentSettings = {},
): Promise<{ ranked: Contender[]; matches: Match[] }> {
  const wins = new Map<string, number>(field.map((c) => [c.concept.id, 0]))
  const conf = new Map<string, number>(field.map((c) => [c.concept.id, 0]))
  const h2h = new Map<string, string>()
  const byes = new Set<string>()
  const matches: Match[] = []

  const play = async (pairs: Array<[Contender, Contender]>, roundLabel: string) => {
    const settled = await Promise.allSettled(pairs.map(([a, b]) => judgePair(brief, a, b, roundLabel, run)))
    settled.forEach((s, i) => {
      const [a, b] = pairs[i]!
      if (s.status === 'rejected') {
        run?.emit('error', `${a.concept.id} vs ${b.concept.id} could not be judged, skipped: ${String(s.reason).slice(0, 200)}`)
        return
      }
      const m = s.value
      h2h.set(key(m.a, m.b), m.winner)
      wins.set(m.winner, wins.get(m.winner)! + 1)
      conf.set(m.winner, conf.get(m.winner)! + m.confidence)
      matches.push(m)
      run?.state.matches.push(m)
      const flag = m.consistent ? '' : ' (order-biased or single pass)'
      run?.emit('select', `${m.a} vs ${m.b} -> ${m.winner}${flag}: ${m.reason}`, m)
    })
  }

  const format = resolveFormat(field.length, settings)
  if (format === 'round-robin') {
    const pairs: Array<[Contender, Contender]> = []
    for (let i = 0; i < field.length; i++) for (let j = i + 1; j < field.length; j++) pairs.push([field[i]!, field[j]!])
    if (pairs.length) {
      run?.emit('select', `${label}: round-robin over ${field.length}, ${pairs.length} matches`)
      await play(pairs, `${label} RR`)
    }
  } else {
    const rounds = Math.ceil(Math.log2(field.length))
    run?.emit('select', `${label}: Swiss over ${field.length}, ${rounds} rounds`)
    for (let r = 1; r <= rounds; r++) {
      const order = [...field].sort((x, y) => wins.get(y.concept.id)! - wins.get(x.concept.id)!)
      let pool = order
      if (pool.length % 2 === 1) {
        const bye = [...pool].reverse().find((c) => !byes.has(c.concept.id)) ?? pool.at(-1)!
        byes.add(bye.concept.id)
        wins.set(bye.concept.id, wins.get(bye.concept.id)! + 1)
        pool = pool.filter((c) => c !== bye)
        run?.emit('select', `${label} round ${r}: ${bye.concept.id} gets a bye (counts as a win)`)
      }
      const pairs = pairUp(pool, h2h)
      run?.emit('select', `${label} round ${r}: ${pairs.length} matches`)
      await play(pairs, `${label} R${r}`)
    }
  }

  const ranked = [...field].sort((x, y) => {
    const dw = wins.get(y.concept.id)! - wins.get(x.concept.id)!
    if (dw) return dw
    const direct = h2h.get(key(x.concept.id, y.concept.id))
    if (direct === x.concept.id) return -1
    if (direct === y.concept.id) return 1
    return conf.get(y.concept.id)! - conf.get(x.concept.id)!
  })
  return { ranked, matches }
}

/** Pair neighbours in the standings, avoiding rematches where possible. Pool must be even. */
function pairUp(order: Contender[], played: Map<string, string>): Array<[Contender, Contender]> {
  const pool = [...order]
  const pairs: Array<[Contender, Contender]> = []
  while (pool.length >= 2) {
    const a = pool.shift()!
    let idx = pool.findIndex((b) => !played.has(key(a.concept.id, b.concept.id)))
    if (idx === -1) idx = 0
    const [b] = pool.splice(idx, 1)
    pairs.push([a, b!])
  }
  return pairs
}

function key(a: string, b: string) {
  return [a, b].sort().join('|')
}
