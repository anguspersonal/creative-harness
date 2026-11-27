import { describe, expect, test } from 'bun:test'
import { defaultOptions, sanitiseOptions } from '../src/config.ts'
import { effectiveScore, normaliseCritique } from '../src/harness/critic.ts'
import { diverge } from '../src/harness/director.ts'
import { criticPrompt, revisePrompt } from '../src/prompts.ts'
import { runHarness } from '../src/harness/loop.ts'
import { key, rankStandings, resolveFormat, tournament } from '../src/harness/selector.ts'
import { Run } from '../src/trace.ts'
import type { Concept } from '../src/types.ts'
import { config } from '../src/config.ts'
import { extractJson } from '../src/util/json.ts'
import { stripStock } from '../src/util/stock.ts'

test('tests run in mock mode with no key', () => {
  expect(config.mock).toBe(true)
  expect(config.falKey).toBe('')
  expect(config.runsDir).toBe('.test-runs')
})
import { createLimiter } from '../src/util/limit.ts'

describe('extractJson', () => {
  test('plain object', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }))
  test('fenced with chatter', () => expect(extractJson('Sure!\n```json\n{"a":[1,2]}\n```\nHope that helps')).toEqual({ a: [1, 2] }))
  test('braces inside strings', () => expect(extractJson('x {"s":"a } b {","n":2} y')).toEqual({ s: 'a } b {', n: 2 }))
  test('no json throws', () => expect(() => extractJson('nothing here')).toThrow())
})

describe('createLimiter', () => {
  test('never exceeds the cap', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active++
          peak = Math.max(peak, active)
          await Bun.sleep(10)
          active--
        }),
      ),
    )
    expect(peak).toBe(2)
  })
  test('a rejection does not jam the queue', async () => {
    const limit = createLimiter(1)
    await expect(limit(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(await limit(async () => 42)).toBe(42)
  })
})

describe('tournament', () => {
  test('swiss: ranks every contender and plays log2(n) rounds', async () => {
    const field = Array.from({ length: 8 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { ranked, matches } = await tournament('brief', field, 'T', undefined, { format: 'swiss' })
    expect(ranked).toHaveLength(8)
    expect(new Set(ranked.map((c) => c.concept.id)).size).toBe(8)
    expect(matches).toHaveLength(3 * 4)
    expect(matches.every((m) => m.consistent)).toBe(true)
  })
  test('swiss: odd field gives a bye without crashing', async () => {
    const field = Array.from({ length: 5 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { ranked } = await tournament('brief', field, 'T', undefined, { format: 'swiss' })
    expect(ranked).toHaveLength(5)
  })
  test('default: 8 contenders get a round-robin, every pair judged exactly once', async () => {
    const field = Array.from({ length: 8 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { ranked, matches } = await tournament('brief', field, 'T')
    expect(ranked).toHaveLength(8)
    expect(matches).toHaveLength(28)
    expect(new Set(matches.map((m) => [m.a, m.b].sort().join('|'))).size).toBe(28)
  })
  test('default: 9 contenders switch to Swiss', async () => {
    const field = Array.from({ length: 9 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { ranked, matches } = await tournament('brief', field, 'T')
    expect(ranked).toHaveLength(9)
    expect(matches.length).toBeLessThan(36)
  })
  test('forced round-robin applies above the auto threshold', async () => {
    const field = Array.from({ length: 9 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { matches } = await tournament('brief', field, 'T', undefined, { format: 'round-robin' })
    expect(matches).toHaveLength(36)
  })
  test('a three-way circular tie breaks on confidence, whatever order the field arrives in', () => {
    const field = Array.from({ length: 3 }, (_, i) => ({ concept: fakeConcept(i) }))
    const [a, b, c] = field.map((f) => f.concept.id) as [string, string, string]
    const wins = new Map([[a, 1], [b, 1], [c, 1]])
    const conf = new Map([[a, 0.5], [b, 0.9], [c, 0.7]])
    const h2h = new Map([[key(a, b), a], [key(b, c), b], [key(a, c), c]])
    for (const order of [field, [...field].reverse(), [field[1]!, field[2]!, field[0]!]]) {
      expect(rankStandings(order, wins, conf, h2h).map((f) => f.concept.id)).toEqual([b, c, a])
    }
  })
  test('a two-way tie still breaks on head-to-head over confidence', () => {
    const field = Array.from({ length: 2 }, (_, i) => ({ concept: fakeConcept(i) }))
    const [a, b] = field.map((f) => f.concept.id) as [string, string]
    const ranked = rankStandings(field, new Map([[a, 1], [b, 1]]), new Map([[a, 0.9], [b, 0.1]]), new Map([[key(a, b), b]]))
    expect(ranked[0]!.concept.id).toBe(b)
  })
  test('sanitiseOptions keeps valid formats and drops unknown ones', () => {
    expect(sanitiseOptions({ tournament: 'swiss', roundRobinMax: 99 })).toEqual({ tournament: 'swiss', roundRobinMax: 16 })
    expect(sanitiseOptions({ tournament: 'knockout' })).toEqual({})
  })
  test('resolveFormat: threshold, forced formats, and tiny fields', () => {
    expect(resolveFormat(8)).toBe('round-robin')
    expect(resolveFormat(9)).toBe('swiss')
    expect(resolveFormat(6, { roundRobinMax: 5 })).toBe('swiss')
    expect(resolveFormat(16, { format: 'round-robin' })).toBe('round-robin')
    expect(resolveFormat(8, { format: 'swiss' })).toBe('swiss')
    expect(resolveFormat(3, { format: 'swiss' })).toBe('round-robin')
  })
})

describe('runHarness (mock)', () => {
  test('end to end: diverge, select, develop, showdown, final', async () => {
    const run = new Run('A test brief', defaultOptions)
    await runHarness(run, { ...defaultOptions, video: true })
    const s = run.state
    expect(s.status).toBe('done')
    expect(s.concepts).toHaveLength(defaultOptions.concepts)
    expect(s.concepts.filter((c) => c.status === 'winner')).toHaveLength(1)
    expect(s.concepts.filter((c) => c.status === 'eliminated')).toHaveLength(defaultOptions.concepts - defaultOptions.finalists)
    // mock critic scores rise per version, so finalists should be revised at least once
    const v2 = s.renders.filter((r) => r.version === 2 && r.id.includes('-v'))
    expect(v2.length).toBeGreaterThan(0)
    expect(v2[0]!.changeSummary).toBeTruthy()
    expect(s.final?.image?.critique).toBeDefined()
    expect(s.final?.video?.kind).toBe('video')
    expect(s.events.at(-1)?.stage).toBe('done')
  })

  test('slop is reported and counts against the ranking', async () => {
    const run = new Run('brief', defaultOptions)
    await runHarness(run, { ...defaultOptions, finalists: 1, concepts: 2 })
    const v1 = run.state.renders.find((r) => r.version === 1)!
    expect(v1.critique!.slop.length).toBeGreaterThan(0)
    expect(effectiveScore(v1.critique!)).toBe(v1.critique!.score - v1.critique!.slop.length)
  })
})

describe('tournament fairness (review fixes)', () => {
  test('3 contenders: round-robin, so every pair is decided directly', async () => {
    const field = Array.from({ length: 3 }, (_, i) => ({ concept: fakeConcept(i) }))
    const { ranked, matches } = await tournament('brief', field, 'Showdown')
    expect(matches).toHaveLength(3)
    // the top contender must not have lost to anyone it is tied with
    const top = ranked[0]!.concept.id
    const second = ranked[1]!.concept.id
    const direct = matches.find((m) => [m.a, m.b].includes(top) && [m.a, m.b].includes(second))!
    const winsOf = (id: string) => matches.filter((m) => m.winner === id).length
    if (winsOf(top) === winsOf(second)) expect(direct.winner).toBe(top)
  })

  for (const n of [5, 7]) {
    test(`${n} contenders: every contender is judged at least once`, async () => {
      const field = Array.from({ length: n }, (_, i) => ({ concept: fakeConcept(i) }))
      const { matches } = await tournament('brief', field, 'Concepts')
      for (const c of field) expect(matches.some((m) => m.a === c.concept.id || m.b === c.concept.id)).toBe(true)
    })
  }
})

describe('normaliseCritique', () => {
  const base = { score: 9, strengths: [], fixes: [], verdict: 'ship' as const }
  test('echoed empty slop entry does not cap the score', () => {
    const c = normaliseCritique({ ...base, slop: [{ flag: '', evidence: '' }, { flag: 'None', evidence: '' }] })
    expect(c.slop).toHaveLength(0)
    expect(c.score).toBe(9)
    expect(c.verdict).toBe('ship')
  })
  test('real slop blocks shipping but keeps the score, so revisions stay comparable', () => {
    const c = normaliseCritique({ ...base, slop: [{ flag: 'Mangled hands', evidence: 'six fingers' }] })
    expect(c.score).toBe(9)
    expect(c.verdict).toBe('revise')
    expect(effectiveScore(c)).toBe(8)
  })
})

describe('resilience (review fixes)', () => {
  const withFail = async (pattern: string, fn: () => Promise<void>) => {
    process.env.MOCK_FAIL = pattern
    try {
      await fn()
    } finally {
      delete process.env.MOCK_FAIL
    }
  }

  test('showdown judge failing still finishes with a winner by critic score', () =>
    withFail('^selector\\.compare:vision$', async () => {
      const run = new Run('brief', defaultOptions)
      await runHarness(run, { ...defaultOptions, concepts: 4, finalists: 2 })
      expect(run.state.status).toBe('done')
      expect(run.state.final?.conceptId).toBeTruthy()
      expect(run.state.events.some((e) => e.stage === 'error')).toBe(true)
    }))

  test('reviser failing keeps the critiqued v1 instead of dropping the finalist', () =>
    withFail('^reviser', async () => {
      const run = new Run('brief', defaultOptions)
      await runHarness(run, { ...defaultOptions, concepts: 4, finalists: 2 })
      expect(run.state.status).toBe('done')
      expect(run.state.renders.filter((r) => r.id.endsWith('-v1') && r.critique)).toHaveLength(2)
    }))

  test('critic down entirely: the run fails loudly instead of hanging', () =>
    withFail('^critic\\.critique:vision$', async () => {
      const run = new Run('brief', defaultOptions)
      await expect(runHarness(run, { ...defaultOptions, concepts: 3, finalists: 1 })).rejects.toThrow()
    }))
})

describe('improve loop (fixes from the first live run)', () => {
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    Object.assign(process.env, vars)
    try {
      await fn()
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k]
    }
  }
  const one = { ...defaultOptions, concepts: 2, finalists: 1, maxIters: 3 }
  const drafts = (run: Run) => run.state.renders.filter((r) => /-v\d+$/.test(r.id))

  test('drafts are not judged on text or anatomy; finals are', () => {
    const c = { score: 7, strengths: [], fixes: [], verdict: 'revise' as const, slop: [
      { flag: 'Garbled or misspelled text in the image', evidence: 'sign reads COFEE' },
      { flag: 'Mangled anatomy: hands', evidence: 'six fingers' },
      { flag: 'Stock-photo composition', evidence: 'centred mug' },
    ] }
    expect(normaliseCritique(c, 'draft').slop.map((s) => s.flag)).toEqual(['Stock-photo composition'])
    expect(normaliseCritique(c, 'final').slop).toHaveLength(3)
  })

  test('the draft filter keeps real flags that merely mention text or hands, and filters render-fault fixes', () => {
    const c = normaliseCritique(
      { score: 8, verdict: 'ship', strengths: [], slop: [
        { flag: 'Made-up brand names, logos or packaging text that the brief did not give', evidence: 'BREWCO on mug' },
        { flag: 'Stock-photo composition: hands holding a mug, centred', evidence: 'centred' },
      ], fixes: ['Correct the garbled lettering', 'Fix the extra finger', 'Move the hands out of the focal area'] },
      'draft',
    )
    expect(c.slop).toHaveLength(2)
    expect(c.score).toBe(8)
    expect(c.verdict).toBe('revise')
    expect(c.fixes).toEqual(['Move the hands out of the focal area'])
  })

  test('the loop critiques drafts at draft stage and the hero at final stage', () =>
    withEnv({ MOCK_TEXT_FLAG: '1' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, one)
      expect(drafts(run).every((r) => !r.critique!.slop.some((s) => /garbled/i.test(s.flag)))).toBe(true)
      const hero = run.state.final?.image?.critique
      expect(hero?.slop.some((s) => /garbled/i.test(s.flag))).toBe(true)
      expect(hero!.verdict).not.toBe('ship')
    }))

  test('a flag listed twice counts once', () => {
    const c = normaliseCritique({ score: 4, strengths: [], fixes: [], verdict: 'revise', slop: [
      { flag: 'Concept and image disagree: the picture does not show the idea', evidence: 'a' },
      { flag: 'Concept and image disagree', evidence: 'b' },
    ] })
    expect(c.slop).toHaveLength(1)
  })

  test('a worse revision is discarded and the best version is revised again', () =>
    withEnv({ MOCK_SCORES: '4,3,6,6' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, patience: 1 })
      const [v1, v2, v3, v4] = drafts(run)
      expect(drafts(run)).toHaveLength(4)
      // v2 scored worse, so v3 was revised from v1 again (the deterministic mock reviser gives the same prompt)
      expect(v3!.prompt).toBe(v2!.prompt)
      expect(v4!.prompt.startsWith(v3!.prompt)).toBe(true)
      expect(v1!.critique!.score).toBe(4)
      expect(run.state.final?.image?.prompt).toBe(v3!.prompt)
      expect(run.state.events.some((e) => e.message.includes('revising v1 again'))).toBe(true)
      // the failed v2 attempt reached the reviser for v3, and was cleared once v3 became the new best
      expect(v3!.changeSummary).toContain('avoiding 1 failed attempt')
      expect(v4!.changeSummary).not.toContain('failed attempt')
    }))

  test('a marginal gain becomes the new base without being reported as a failure', () =>
    withEnv({ MOCK_SCORES: '5,5.3,5.4' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, maxIters: 2, patience: 2 })
      const [, v2, v3] = drafts(run)
      expect(v3!.prompt.startsWith(v2!.prompt)).toBe(true)
      expect(v3!.changeSummary).not.toContain('failed attempt')
      expect(run.state.events.some((e) => e.message.includes('c2-v2 is the new best, but only by 0.3'))).toBe(true)
      expect(run.state.events.some((e) => /did not beat v2/.test(e.message))).toBe(false)
    }))

  test('a high-scoring "kill" on a revision is still discarded, never kept or shipped', () =>
    withEnv({ MOCK_SCORES: '5,9,6', MOCK_VERDICTS: 'revise,kill,revise' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, maxIters: 2 })
      const [, v2, v3] = drafts(run)
      expect(v2!.discarded).toBe(true)
      expect(v3).toBeDefined()
      expect(v3!.prompt).toBe(v2!.prompt)
      expect(run.state.final?.image?.prompt).toBe(v3!.prompt)
    }))

  test('a clean render outranks a slightly higher-scored one with slop, and the loop keeps it', () =>
    withEnv({ MOCK_SCORES: '7,7.5', MOCK_SLOP: '0,1' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, maxIters: 1 })
      const [v1, v2] = drafts(run)
      expect(v2!.critique!.score).toBeGreaterThan(v1!.critique!.score)
      expect(effectiveScore(v2!.critique!)).toBeLessThan(effectiveScore(v1!.critique!))
      expect(run.state.final?.image?.prompt).toBe(v1!.prompt)
    }))

  test('a high score with slop does not ship early; the clean one does', () =>
    withEnv({ MOCK_SCORES: '9,9,9', MOCK_SLOP: '1,0,0' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, one)
      const [v1, v2] = drafts(run)
      expect(v1!.critique!.verdict).toBe('revise')
      expect(v2!.critique!.verdict).toBe('ship')
      expect(drafts(run)).toHaveLength(2)
    }))

  test('patience 0 stops at the first version that does not improve', () =>
    withEnv({ MOCK_SCORES: '4,3' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, patience: 0 })
      expect(drafts(run)).toHaveLength(2)
    }))

  test('a "kill" on a revision discards that revision instead of the concept', () =>
    withEnv({ MOCK_SCORES: '5,2,6', MOCK_VERDICTS: 'revise,kill,revise' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, { ...one, maxIters: 2 })
      expect(run.state.status).toBe('done')
      expect(run.state.events.some((e) => e.message.includes('killed by the critic'))).toBe(false)
      expect(run.state.final?.image?.prompt).toBe(drafts(run)[2]!.prompt)
    }))

  test('a "kill" on the first draft still kills the concept', () =>
    withEnv({ MOCK_VERDICTS: 'kill' }, async () => {
      const run = new Run('brief', one)
      await runHarness(run, one)
      expect(drafts(run)).toHaveLength(1)
      expect(run.state.events.some((e) => e.message.includes('killed by the critic'))).toBe(true)
    }))

  test('with video off every concept is a still image', async () => {
    expect((await diverge('brief', 6, false)).every((c) => c.medium === 'image')).toBe(true)
    expect((await diverge('brief', 6, true)).some((c) => c.medium === 'video')).toBe(true)
  })

  test('prompts carry the stage and the failed attempts', () => {
    const c = fakeConcept(1)
    const crit = { score: 4, slop: [], strengths: ['warm light'], fixes: ['crop tighter'], verdict: 'revise' as const }
    expect(criticPrompt('b', c, 1, 'draft')).toContain('STAGE: DRAFT')
    expect(criticPrompt('b', c, 1, 'final')).toContain('STAGE: FINAL')
    const r = revisePrompt(c, 'p', crit, [{ changeSummary: 'added a neon sign', score: 3 }])
    expect(r).toContain('ALREADY TRIED')
    expect(r).toContain('added a neon sign (scored 3/10)')
    expect(revisePrompt(c, 'p', crit)).not.toContain('ALREADY TRIED')
  })
})

describe('stock-photo vocabulary (tuning after run 3)', () => {
  test('stripStock removes stock phrases and leaves a clean prompt', () => {
    const s = stripStock('A barista mid-spill, shallow depth of field, soft bokeh lights, cozy cafe, golden hour light, cropped at the elbow.')
    expect(s.prompt).toBe('A barista mid-spill, cafe, cropped at the elbow.')
    expect(s.removed).toEqual(expect.arrayContaining(['shallow depth of field', 'soft bokeh lights', 'cozy', 'golden hour light']))
  })
  test('stripStock leaves clean prompts untouched', () => {
    const p = 'A hand knocks a cup off a ledge, cropped at the wrist, low vantage point, hard flash.'
    expect(stripStock(p)).toEqual({ prompt: p, removed: [] })
  })
  test('stripStock drops placement words the image model takes literally', () => {
    expect(stripStock('A clock centered behind her head, cups perfectly symmetrical on the bar.').prompt).toBe('A clock behind her head, cups on the bar.')
    expect(stripStock('Mug dead-centred, eye-level.').prompt).toBe('Mug, eye-level.')
  })
  test('the director strips stock vocabulary and reports the cliches it refused', async () => {
    const run = new Run('brief', defaultOptions)
    const concepts = await diverge('brief', 4, false, run)
    expect(concepts.every((c) => !/depth of field/i.test(c.visualPrompt))).toBe(true)
    expect(concepts.every((c) => c.moment.length > 0)).toBe(true)
    expect(run.state.events.some((e) => e.message.startsWith('Refused the obvious: latte art'))).toBe(true)
    expect(run.state.events.some((e) => e.message.includes('Stripped stock vocabulary'))).toBe(true)
  })
  test('the critic is not shown the image prompt, so it judges the result', () => {
    const c = { ...fakeConcept(1), visualPrompt: 'SECRET-PROMPT-TEXT chair facing inland' }
    for (const stage of ['draft', 'final'] as const) {
      const p = criticPrompt('b', c, 2, stage)
      expect(p).not.toContain('SECRET-PROMPT-TEXT')
      expect(p).not.toContain('PROMPT USED')
      expect(p).toContain('VERSION: 2')
    }
  })

  test('the critic and judge see the moment', () => {
    expect(criticPrompt('b', { ...fakeConcept(1), moment: 'a cup mid-fall' }, 1, 'draft')).toContain('Moment: a cup mid-fall')
  })
})

function fakeConcept(i: number): Concept {
  return { id: `c${i}`, title: `Concept ${i}: t${i}`, hook: 'h', idea: 'i', moment: 'm', axis: 'a', medium: 'image', visualPrompt: 'p', whyItWorks: 'w', status: 'pending' }
}
