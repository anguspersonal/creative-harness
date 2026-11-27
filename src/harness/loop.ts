import { type HarnessOptions, defaultOptions } from '../config.ts'
import { generateMedia } from '../media.ts'
import { ROLES } from '../models.ts'
import { type FailedAttempt, heroPrompt, motionPrompt } from '../prompts.ts'
import { Run } from '../trace.ts'
import type { Concept, Critique, Render } from '../types.ts'
import { critique, effectiveScore, revise } from './critic.ts'
import { diverge } from './director.ts'
import { tournament } from './selector.ts'
import { stripStock } from '../util/stock.ts'

// The harness:
//   1. diverge   - director writes N concepts on different axes
//   2. select    - text-only tournament picks K finalists (cheap: no renders yet)
//   3. develop   - each finalist: draft render -> critic -> reviser, until ship / plateau / max
//   4. showdown  - vision judge compares the finalists' best renders head to head
//   5. final     - re-render the winner on the hero model, optionally animate it
//
// Failure policy: once money has been spent on renders, a single failed call
// degrades the run (logged as an error event) instead of ending it.

export function startRun(brief: string, opts: Partial<HarnessOptions> = {}): Run {
  const options = { ...defaultOptions, ...opts }
  const run = new Run(brief, options)
  runHarness(run, options).catch((err) => {
    run.emit('error', err instanceof Error ? err.message : String(err))
    run.finish('error', String(err))
  })
  return run
}

type Developed = { concept: Concept; render: Render; killed: boolean }

export async function runHarness(run: Run, o: HarnessOptions): Promise<void> {
  const { brief } = run.state
  run.emit('brief', brief)

  // 1. Diverge
  const concepts = await diverge(brief, o.concepts, o.video, run)
  run.state.concepts = concepts
  run.emit('diverge', `${concepts.length} concepts across axes: ${concepts.map((c) => c.axis).join(', ')}`)

  // 2. Select
  const format = { format: o.tournament, roundRobinMax: o.roundRobinMax }
  const { ranked } = await tournament(brief, concepts.map((concept) => ({ concept })), 'Concepts', run, format)
  const finalists = ranked.slice(0, o.finalists).map((c) => c.concept)
  for (const c of concepts) c.status = finalists.includes(c) ? 'finalist' : 'eliminated'
  run.emit('select', `Finalists: ${finalists.map((c) => `${c.id} "${c.title}"`).join(', ')}`)

  // 3. Develop each finalist in parallel (the fal limiter keeps us under the concurrency cap)
  const settled = await Promise.allSettled(finalists.map((c) => develop(run, c, o)))
  const developed: Developed[] = []
  settled.forEach((r, i) => {
    const concept = finalists[i]!
    if (r.status === 'fulfilled') developed.push({ concept, ...r.value })
    else {
      concept.status = 'eliminated'
      run.emit('error', `${concept.id} produced nothing usable: ${String(r.reason).slice(0, 300)}`)
    }
  })
  // Killed concepts sit out the showdown, unless every finalist was killed.
  let bests = developed.filter((d) => !d.killed)
  if (bests.length === 0 && developed.length > 0) {
    run.emit('critique', 'Critic killed every finalist; falling back to the best-scored one')
    bests = developed
  }
  for (const d of developed) if (d.killed && !bests.includes(d)) d.concept.status = 'eliminated'
  if (bests.length === 0) throw new Error('No finalist produced a render')

  // 4. Showdown on the actual images. If judging fails, fall back to critic scores.
  const rank = (d: Developed) => (d.render.critique ? effectiveScore(d.render.critique) : -Infinity)
  const byScore = [...bests].sort((x, y) => rank(y) - rank(x))
  let winner = byScore[0]!
  let reason = bests.length === 1 ? 'Only finalist standing.' : 'Highest critic score.'
  if (bests.length > 1) {
    try {
      const { ranked: final, matches } = await tournament(
        brief,
        bests.map((b) => ({ concept: b.concept, imageUrl: b.render.url })),
        'Showdown',
        run,
        format,
      )
      if (matches.length > 0) {
        winner = bests.find((b) => b.concept.id === final[0]!.concept.id)!
        reason = matches.filter((m) => m.winner === winner.concept.id).at(-1)?.reason ?? reason
      }
    } catch (err) {
      run.emit('error', `Showdown failed, using critic scores: ${String(err).slice(0, 200)}`)
    }
  }
  winner.concept.status = 'winner'
  run.emit('showdown', `Winner: ${winner.concept.id} "${winner.concept.title}" (${winner.render.critique ? scoreText(winner.render.critique) : '?'}). ${reason}`)

  // 5. Final hero render. Show it as soon as it exists; critique and video are extras.
  run.state.final = { conceptId: winner.concept.id, image: winner.render, reason }
  try {
    const heroMedia = await generateMedia(ROLES.final, { prompt: heroPrompt(winner.render.prompt) }, run)
    const hero: Render = { ...heroMedia, id: `${winner.concept.id}-final`, conceptId: winner.concept.id, version: winner.render.version + 1, prompt: winner.render.prompt }
    run.state.renders.push(hero)
    run.state.final.image = hero
    run.emit('final', `Hero image on ${hero.endpoint}`, { renderId: hero.id })
    try {
      hero.critique = await critique(brief, winner.concept, hero, 'final', run)
      run.emit('final', `Hero critique: ${scoreText(hero.critique)}`)
    } catch (err) {
      run.emit('error', `Hero critique failed (image kept): ${String(err).slice(0, 200)}`)
    }
  } catch (err) {
    run.emit('error', `Hero render failed, keeping the best draft: ${String(err).slice(0, 200)}`)
  }

  if (o.video) {
    const still = run.state.final.image!
    try {
      const vidMedia = await generateMedia(ROLES.video, { prompt: motionPrompt(winner.concept), imageUrl: still.url, seconds: 5 }, run)
      const video: Render = { ...vidMedia, id: `${winner.concept.id}-video`, conceptId: winner.concept.id, version: still.version, prompt: motionPrompt(winner.concept) }
      run.state.renders.push(video)
      run.state.final.video = video
      run.emit('final', `Video on ${video.endpoint} (${Math.round(video.ms / 1000)}s)`, { renderId: video.id })
    } catch (err) {
      run.emit('error', `Video failed (image kept): ${String(err).slice(0, 200)}`)
    }
  }

  run.emit('done', `Done in ${Math.round((Date.now() - run.state.startedAt) / 1000)}s, ~$${run.state.spend.usd.toFixed(3)} across ${run.state.spend.calls} calls`)
  run.finish('done')
}

/**
 * Draft -> critique -> revise until the critic says ship, the score stops improving, or we run out of rounds.
 *
 * Revisions always start from the best version so far, not the latest: a revision that made things worse
 * is discarded (and named to the reviser so it tries something else), rather than built upon.
 * Returns the best critiqued render so far even if a later call fails; throws only if nothing was scored.
 */
async function develop(run: Run, concept: Concept, o: HarnessOptions): Promise<{ render: Render; killed: boolean }> {
  const { brief } = run.state
  let prompt = concept.visualPrompt
  let best: Render | undefined
  let stale = 0
  let failedFromBest: FailedAttempt[] = []
  let changeSummary: string | undefined
  let killed = false
  let lastError: unknown

  for (let version = 1; version <= o.maxIters + 1; version++) {
    try {
      const media = await generateMedia(ROLES.draft, { prompt }, run)
      const render: Render = { ...media, id: `${concept.id}-v${version}`, conceptId: concept.id, version, prompt, changeSummary }
      run.state.renders.push(render)
      run.emit('draft', `${render.id} rendered in ${(render.ms / 1000).toFixed(1)}s`, { renderId: render.id })

      const crit = await critique(brief, concept, render, 'draft', run)
      render.critique = crit
      const slop = crit.slop.map((s) => s.flag).join(', ') || 'no slop'
      run.emit('critique', `${render.id}: ${scoreText(crit)}, ${crit.verdict} (${slop})`, { renderId: render.id })

      // Only the first draft tests the idea itself. A later "kill" means the revision broke it, so it's discarded.
      if (crit.verdict === 'kill' && version === 1) {
        best = render
        killed = true
        run.emit('critique', `${concept.id} killed by the critic: the idea itself does not work`)
        break
      }
      const discarded = crit.verdict === 'kill'
      if (discarded) render.discarded = true
      if (discarded) run.emit('critique', `${render.id} was judged unworkable; discarding it and keeping v${best!.version}`)

      const prevBest = best
      const eff = effectiveScore(crit)
      const bestEff = prevBest ? effectiveScore(prevBest.critique!) : -Infinity
      const improved = !discarded && eff >= bestEff + o.plateau
      const newBest = !discarded && eff > bestEff
      if (newBest) {
        best = render
        failedFromBest = []
      }
      // Shipping needs a clean image: normaliseCritique already turns a slop-flagged "ship" into "revise".
      if (!discarded && (crit.verdict === 'ship' || (crit.score >= o.shipScore && crit.slop.length === 0))) break

      if (improved) stale = 0
      else {
        stale++
        // Tell the reviser what didn't work, unless this attempt became the new (marginally) best base.
        if (!newBest) failedFromBest.push({ changeSummary: changeSummary ?? '(revision)', score: eff })
        if (stale > o.patience) {
          run.emit('critique', `${concept.id} stopped improving (best v${best!.version} at ${scoreText(best!.critique!)})`)
          break
        }
        if (version < o.maxIters + 1) {
          run.emit(
            'critique',
            newBest
              ? `${render.id} is the new best, but only by ${(eff - bestEff).toFixed(1)}; revising it again`
              : `${render.id} did not beat v${best!.version} (${scoreText(best!.critique!)}); revising v${best!.version} again`,
          )
        }
      }
      if (version === o.maxIters + 1) break

      const base = best!
      const rev = await revise(concept, base.prompt, base.critique!, failedFromBest, run)
      const clean = stripStock(rev.visualPrompt)
      prompt = clean.prompt
      changeSummary = rev.changeSummary
      run.emit('revise', `${concept.id} v${version + 1} (from v${base.version}): ${rev.changeSummary}${clean.removed.length ? ` [stripped: ${clean.removed.join(', ')}]` : ''}`)
    } catch (err) {
      lastError = err
      run.emit('error', `${concept.id} v${version} failed: ${String(err).slice(0, 200)}`)
      break
    }
  }
  if (!best) throw lastError ?? new Error(`${concept.id}: no render was critiqued`)
  return { render: best, killed }
}

/** "7/10" for a clean render, "7/10 - 2 slop = 5" when flags cost points in the ranking. */
function scoreText(c: Critique): string {
  return c.slop.length ? `${c.score}/10 - ${c.slop.length} slop = ${effectiveScore(c)}` : `${c.score}/10`
}
