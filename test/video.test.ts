import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultOptions, sanitiseOptions } from '../src/config.ts'
import { runHarness } from '../src/harness/loop.ts'
import { assessVideo, betterVideo, verifyVideo, videoScore } from '../src/harness/verifier.ts'
import { Run } from '../src/trace.ts'
import type { Inspection, VideoCheck } from '../src/types.ts'
import { ffmpegAvailable, mockClip, type MockScenario, mockScenarioFor, openClip } from '../src/video/clip.ts'
import { injectFault } from '../src/video/inject.ts'
import { analyse, changedRegion, GRID, impulses, pickMoments, THRESHOLDS } from '../src/video/signals.ts'

const concept = { title: 'A test concept', hook: 'A ball crosses the frame', idea: 'Something crosses the frame.', moment: 'The ball is halfway across.' }
const measure = (scenario: MockScenario) => {
  const clip = mockClip(scenario)
  return analyse(clip.grey, clip.fps)
}
const sudden = (s: ReturnType<typeof analyse>) => s.moments.filter((m) => m.kind !== 'fastest')

afterEach(() => {
  delete process.env.MOCK_FAIL
  delete process.env.MOCK_VIDEO
})

describe('signals: measured on every frame', () => {
  test('a clean clip moves from the start and has no sudden changes', () => {
    const s = measure('ok')
    expect(s.frames).toBe(120)
    expect(s.frozen).toBe(false)
    expect(s.deadStart).toBe(false)
    expect(s.firstMoveAt).toBe(0)
    expect(sudden(s)).toHaveLength(0)
    // With nothing sudden to look at, the model is still pointed at the fastest movement.
    expect(pickMoments(s).length).toBeGreaterThan(0)
    expect(pickMoments(s).every((m) => m.kind === 'fastest')).toBe(true)
  })

  test('a frozen clip is frozen, and nothing else is reported about it', () => {
    const s = measure('frozen')
    expect(s.frozen).toBe(true)
    expect(s.stillShare).toBe(1)
    expect(s.deadStart).toBe(false)
    expect(s.moments).toHaveLength(0)
  })

  test('a clip that waits 1.6s before moving has a dead first second', () => {
    const s = measure('slow')
    expect(s.frozen).toBe(false)
    expect(s.deadStart).toBe(true)
    expect(s.firstSecondStill).toBe(1)
    expect(s.firstMoveAt).toBeGreaterThan(1.5)
    expect(s.firstMoveAt).toBeLessThan(1.8)
    // Movement that starts is a step, not an impulse: it must not be reported as a sudden change.
    expect(sudden(s)).toHaveLength(0)
  })

  test('something that appears for one frame is found at the right time, with the area it is in', () => {
    const found = sudden(measure('pop'))
    expect(found).toHaveLength(1)
    expect(found[0]!.t).toBe(2.5)
    const r = found[0]!.region!
    // The block is drawn at the top right of the frame.
    expect(r.x + r.w / 2).toBeGreaterThan(0.5)
    expect(r.y + r.h / 2).toBeLessThan(0.5)
    expect(pickMoments(measure('pop')).some((m) => m.t === 2.5)).toBe(true)
  })

  test('a cut is found as a jump of the whole frame', () => {
    const found = sudden(measure('cut'))
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('jump')
    expect(found[0]!.t).toBe(2.5)
    expect(found[0]!.region).toBeUndefined()
  })

  test('impulses: a spike is reported, a step is not, and repeated frames do not fake one', () => {
    const steady = Array.from({ length: 40 }, () => 2)
    expect(impulses(steady, 4, 2)).toHaveLength(0)
    const spike = [...steady]
    spike[20] = 30
    expect(impulses(spike, 4, 2).map((i) => i.pair)).toEqual([20])
    // Movement starting from stillness: high on one side only.
    const step = [...Array.from({ length: 20 }, () => 0), ...Array.from({ length: 20 }, () => 6)]
    expect(impulses(step, 4, 2)).toHaveLength(0)
    // Every frame shown twice (frame-rate padding): motion alternates between 0 and a steady value.
    const padded = Array.from({ length: 40 }, (_, i) => (i % 2 ? 5 : 0))
    expect(impulses(padded, 4, 2)).toHaveLength(0)
    // A one-frame glitch changes twice, in and out. It is one event.
    const glitch = [...steady]
    glitch[20] = 30
    glitch[21] = 28
    expect(impulses(glitch, 4, 2)).toHaveLength(1)
    // In a still clip anything over the floor is sudden.
    const still = Array.from({ length: 40 }, () => 0)
    still[10] = 9
    expect(impulses(still, 4, 2).map((i) => i.pair)).toEqual([10])
  })

  test('changedRegion zooms into a local change and gives up on a frame-wide one', () => {
    const blank = new Uint8Array(GRID * GRID).fill(80)
    const local = blank.slice()
    for (let y = 30; y < 36; y++) for (let x = 6; x < 12; x++) local[y * GRID + x] = 220
    const box = changedRegion(blank, local)!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.w).toBeLessThanOrEqual(1.001)
    expect(box.y + box.h).toBeLessThanOrEqual(1.001)
    expect(box.x).toBeLessThanOrEqual(6 / GRID)
    expect(box.x + box.w).toBeGreaterThanOrEqual(12 / GRID)
    expect(box.w).toBeGreaterThanOrEqual(1 / 3 - 0.001)
    expect(changedRegion(blank, new Uint8Array(GRID * GRID).fill(200))).toBeUndefined()
    expect(changedRegion(blank, blank)).toBeUndefined()
    // A change in a corner must not push the zoom outside the frame.
    const corner = blank.slice()
    corner[0] = 255
    const c = changedRegion(blank, corner)!
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
  })

  test('at most maxMoments are handed to the model, sudden changes first', () => {
    const s = measure('pop')
    const picked = pickMoments(s)
    expect(picked.length).toBeLessThanOrEqual(THRESHOLDS.maxMoments)
    expect(pickMoments(s, 1)[0]!.kind).not.toBe('fastest')
  })
})

describe('assessVideo: the verdict is decided in code', () => {
  const signals = measure('ok')
  const base = { signals, inspections: [] as Inspection[], unchecked: [] as string[] }
  const hook = { changes: 'The ball starts to move.', eventStarted: true, frames: [] }
  const action = { beats: ['a', 'b'], sceneChanges: true, deliversMoment: true, impossible: [], score: 8, fixes: [], frames: [] }
  const inspection = (finding: Inspection['finding'], kind: Inspection['kind'] = 'pop'): Inspection => ({ t: 2.5, kind, ratio: 6, zoomed: false, frames: [], finding })

  test('clean answers from every check pass', () => {
    const c = assessVideo({ ...base, hook, action, drift: { consistent: true, changes: [], frames: [] } })
    expect(c.verdict).toBe('pass')
    expect(c.flags).toHaveLength(0)
    expect(c.score).toBe(8)
  })

  test('a frozen clip is flagged from the measurement alone and scores 0', () => {
    const c = assessVideo({ ...base, signals: measure('frozen') })
    expect(c.verdict).toBe('retry')
    expect(c.flags.map((f) => [f.flag, f.source])).toEqual([['Frozen', 'measured']])
    expect(c.score).toBe(0)
  })

  test('a measured dead start is flagged even when the model says an event starts', () => {
    const c = assessVideo({ ...base, signals: measure('slow'), hook, action })
    expect(c.flags.map((f) => [f.flag, f.source])).toEqual([['Dead first second', 'measured']])
    expect(c.verdict).toBe('retry')
  })

  test('the model can also flag a dead first second when the pixels do move', () => {
    const c = assessVideo({ ...base, hook: { ...hook, changes: 'Only the camera drifts.', eventStarted: false }, action })
    expect(c.flags.map((f) => [f.flag, f.source])).toEqual([['Dead first second', 'model']])
  })

  test('a fault the model is unsure of, or cannot describe, is not a flag', () => {
    const unsure = assessVideo({ ...base, hook, action, inspections: [inspection({ changed: 'Maybe the cup changes.', kind: 'fault', flag: 'Morphing', confidence: 0.3 })] })
    expect(unsure.flags).toHaveLength(0)
    const empty = assessVideo({ ...base, hook, action, inspections: [inspection({ changed: ' ', kind: 'fault', flag: 'Morphing', confidence: 0.9 })] })
    expect(empty.flags).toHaveLength(0)
    const real = assessVideo({ ...base, hook, action, inspections: [inspection({ changed: 'The handle vanishes.', kind: 'fault', flag: 'Pop or flicker: handle', confidence: 0.9 })] })
    expect(real.flags).toEqual([{ flag: 'Pop or flicker', evidence: 'The handle vanishes.', at: 2.5, source: 'model' }])
  })

  test('a cut is named a cut, and a fault with no flag name gets one from why the frame was looked at', () => {
    const cut = assessVideo({ ...base, inspections: [inspection({ changed: 'A new scene.', kind: 'cut', flag: '', confidence: 0.8 }, 'jump')] })
    expect(cut.flags[0]!.flag).toBe('Unintended cut')
    const unnamed = assessVideo({ ...base, inspections: [inspection({ changed: 'The hand melts.', kind: 'fault', flag: '', confidence: 0.8 }, 'fastest')] })
    expect(unnamed.flags[0]!.flag).toBe('Morphing')
    const moved = assessVideo({ ...base, inspections: [inspection({ changed: 'The hand moves.', kind: 'motion', flag: '', confidence: 0.9 })] })
    expect(moved.flags).toHaveLength(0)
  })

  test('"not consistent" with nothing listed is not a flag; listed drift is, at most twice', () => {
    const vague = assessVideo({ ...base, hook, action, drift: { consistent: false, changes: [], frames: [] } })
    expect(vague.flags).toHaveLength(0)
    const changes = ['face', 'mug', 'window'].map((what) => ({ what, evidence: '' }))
    const drifted = assessVideo({ ...base, hook, action, drift: { consistent: false, changes, frames: [] } })
    expect(drifted.flags.map((f) => f.flag)).toEqual(['Identity drift', 'Identity drift'])
  })

  test('whole-clip answers become flags', () => {
    const c = assessVideo({ ...base, hook, action: { ...action, sceneChanges: false, deliversMoment: false, impossible: [{ what: 'Coffee flows upwards', evidence: 'frames 3-4' }] } })
    expect(c.flags.map((f) => f.flag)).toEqual(['Only the camera moves', 'Motion misses the idea', 'Impossible motion'])
    expect(videoScore(c)).toBe(8 - 3)
  })

  test('a check that could not run means unchecked, never pass; a flag still means retry', () => {
    const partial = assessVideo({ ...base, hook, action, unchecked: ['start-to-end comparison: timeout'] })
    expect(partial.verdict).toBe('unchecked')
    const flagged = assessVideo({ ...base, hook: { ...hook, eventStarted: false }, unchecked: ['whole-clip check: timeout'] })
    expect(flagged.verdict).toBe('retry')
  })

  test('betterVideo: a clean clip beats a flagged one, then the higher score wins', () => {
    const clean = assessVideo({ ...base, hook, action: { ...action, score: 5 } })
    const flagged = assessVideo({ ...base, hook: { ...hook, eventStarted: false }, action: { ...action, score: 9 } })
    expect(betterVideo(clean, flagged)).toBe(true)
    expect(betterVideo(flagged, clean)).toBe(false)
    const better = assessVideo({ ...base, hook, action: { ...action, score: 7 } })
    expect(betterVideo(better, clean)).toBe(true)
    // An unchecked clip has no evidence against it, so it is kept over a flagged one.
    const unchecked: VideoCheck = { inspections: [], flags: [], verdict: 'unchecked', unchecked: ['no ffmpeg'] }
    expect(betterVideo(unchecked, flagged)).toBe(true)
  })
})

describe('verifyVideo (mock clips with a known fault)', () => {
  const verify = (scenario: MockScenario) => verifyVideo({ concept, source: 'mock', label: scenario, clip: mockClip(scenario) })

  test('a clean clip passes, with every check recorded and the frames it looked at', async () => {
    const c = await verify('ok')
    expect(c.verdict).toBe('pass')
    expect(c.unchecked).toHaveLength(0)
    expect(c.hook!.frames).toHaveLength(5)
    expect(c.hook!.frames.map((f) => f.t)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(c.drift!.frames.map((f) => f.t)).toEqual([0, 2.5, 4.96])
    expect(c.action!.frames).toHaveLength(8)
    expect(c.inspections.length).toBeGreaterThan(0)
    expect(c.inspections.every((i) => i.finding?.kind === 'motion')).toBe(true)
    expect(c.score).toBe(7.5)
  })

  test('a one-frame pop is found, looked at up close, and flagged with its time', async () => {
    const c = await verify('pop')
    expect(c.verdict).toBe('retry')
    expect(c.flags).toHaveLength(1)
    expect(c.flags[0]).toMatchObject({ flag: 'Pop or flicker', at: 2.5, source: 'model' })
    const looked = c.inspections.find((i) => i.t === 2.5)!
    expect(looked.zoomed).toBe(true)
    // The frame before, the frame itself, the frame after; plus the whole frame for context.
    expect(looked.frames.map((f) => f.t)).toEqual([2.46, 2.5, 2.54])
    expect(looked.context!.t).toBe(2.5)
  })

  test('a cut, drift and a dead start each get their own flag', async () => {
    expect((await verify('cut')).flags.map((f) => f.flag)).toEqual(['Unintended cut'])
    expect((await verify('morph')).flags.map((f) => f.flag)).toEqual(['Identity drift'])
    const slow = await verify('slow')
    expect(slow.flags.map((f) => [f.flag, f.source])).toEqual([['Dead first second', 'measured']])
  })

  test('a frozen clip is flagged without paying a model to look', async () => {
    process.env.MOCK_FAIL = '^video\\.'
    const c = await verify('frozen')
    expect(c.verdict).toBe('retry')
    expect(c.flags[0]!.flag).toBe('Frozen')
    // Every model call is set to fail; none was made, so nothing is unchecked.
    expect(c.unchecked).toHaveLength(0)
    expect(c.hook).toBeUndefined()
  })

  test('one failed check is reported as unchecked and the others still run', async () => {
    process.env.MOCK_FAIL = '^video\\.drift'
    const run = new Run('brief', defaultOptions)
    const c = await verifyVideo({ concept, source: 'mock', label: 'x', clip: mockClip('ok') }, run)
    expect(c.verdict).toBe('unchecked')
    expect(c.unchecked).toHaveLength(1)
    expect(c.unchecked[0]).toContain('start-to-end')
    expect(c.drift).toBeUndefined()
    expect(c.hook).toBeDefined()
    expect(c.action).toBeDefined()
    expect(run.state.events.some((e) => e.stage === 'error' && e.message.includes('start-to-end'))).toBe(true)
    expect(run.state.events.filter((e) => e.stage === 'verify').length).toBeGreaterThan(3)
  })

  test('a failed check does not hide a fault another check found', async () => {
    process.env.MOCK_FAIL = '^video\\.action'
    const c = await verify('pop')
    expect(c.verdict).toBe('retry')
    expect(c.score).toBeUndefined()
    expect(c.unchecked).toHaveLength(1)
  })

  test('modelChecks: false measures only', async () => {
    process.env.MOCK_FAIL = '^video\\.'
    const c = await verifyVideo({ concept, source: 'mock', label: 'x', clip: mockClip('pop'), modelChecks: false })
    expect(c.signals!.moments.some((m) => m.t === 2.5)).toBe(true)
    expect(c.inspections).toHaveLength(0)
    expect(c.verdict).toBe('unchecked')
  })

  test('a clip that cannot be read is unchecked, not an exception', async () => {
    const c = await verifyVideo({ concept, source: '/no/such/clip.mp4', label: 'x' })
    expect(c.verdict).toBe('unchecked')
    expect(c.signals).toBeUndefined()
    expect(c.unchecked[0]).toContain('could not be read')
  })
})

describe('runHarness with video (mock)', () => {
  const videoRun = async (opts: Partial<typeof defaultOptions> = {}) => {
    const run = new Run('A test brief', defaultOptions)
    await runHarness(run, { ...defaultOptions, concepts: 2, finalists: 1, maxIters: 0, video: true, ...opts })
    return run.state
  }
  const videos = (s: Run['state']) => s.renders.filter((r) => r.kind === 'video')

  test('a flagged clip is retried with a revised motion prompt, and the clean one is kept', async () => {
    const s = await videoRun()
    expect(s.status).toBe('done')
    const [first, second] = videos(s)
    expect(videos(s)).toHaveLength(2)
    expect(first!.videoCheck!.verdict).toBe('retry')
    expect(second!.videoCheck!.verdict).toBe('pass')
    expect(second!.changeSummary).toBeTruthy()
    expect(second!.prompt).not.toBe(first!.prompt)
    expect(second!.prompt).toContain(first!.prompt)
    expect(s.final!.video!.id).toBe(second!.id)
    expect(s.events.some((e) => e.stage === 'revise' && e.message.includes('video attempt 2'))).toBe(true)
    expect(s.events.some((e) => e.stage === 'verify' && e.message.includes('retry'))).toBe(true)
  })

  test('a clip that passes first time is not re-rendered', async () => {
    process.env.MOCK_VIDEO = 'ok'
    const s = await videoRun({ videoAttempts: 3 })
    expect(videos(s)).toHaveLength(1)
    expect(s.final!.video!.videoCheck!.verdict).toBe('pass')
  })

  test('attempts stop at videoAttempts, and the best flagged clip is still delivered', async () => {
    process.env.MOCK_VIDEO = 'frozen,cut,pop'
    const s = await videoRun({ videoAttempts: 2 })
    expect(videos(s)).toHaveLength(2)
    // Frozen scores 0 - 1; the cut scores 6.5 - 1. The cut is the better of two flagged clips.
    expect(s.final!.video!.videoCheck!.flags[0]!.flag).toBe('Unintended cut')
    expect(s.status).toBe('done')
  })

  test('videoAttempts: 1 checks the clip but does not retry', async () => {
    const s = await videoRun({ videoAttempts: 1 })
    expect(videos(s)).toHaveLength(1)
    expect(s.final!.video!.videoCheck!.verdict).toBe('retry')
    expect(s.events.some((e) => e.message.includes('video attempt 2'))).toBe(false)
  })

  test('a failed revision keeps the clip already made', async () => {
    process.env.MOCK_FAIL = '^video\\.revise'
    const s = await videoRun()
    expect(s.status).toBe('done')
    expect(videos(s)).toHaveLength(1)
    expect(s.final!.video!.id).toBe(videos(s)[0]!.id)
    expect(s.events.some((e) => e.stage === 'error' && e.message.includes('could not be revised'))).toBe(true)
  })

  test('a video render that fails leaves the image as the result', async () => {
    process.env.MOCK_FAIL = '^media\\.video$'
    const s = await videoRun()
    expect(s.status).toBe('done')
    expect(videos(s)).toHaveLength(0)
    expect(s.final!.video).toBeUndefined()
    expect(s.final!.image).toBeDefined()
    expect(s.events.some((e) => e.stage === 'error' && e.message.includes('Video attempt 1 failed (image kept)'))).toBe(true)
  })

  test('with video off, nothing is rendered or checked', async () => {
    const s = await videoRun({ video: false })
    expect(videos(s)).toHaveLength(0)
    expect(s.final!.video).toBeUndefined()
    expect(s.events.some((e) => e.stage === 'verify')).toBe(false)
  })

  test('options: videoAttempts is clamped; mock scenarios follow MOCK_VIDEO', () => {
    expect(sanitiseOptions({ videoAttempts: 99 })).toEqual({ videoAttempts: 4 })
    expect(sanitiseOptions({ videoAttempts: 0 })).toEqual({ videoAttempts: 1 })
    expect(mockScenarioFor(1)).toBe('pop')
    expect(mockScenarioFor(2)).toBe('ok')
    process.env.MOCK_VIDEO = 'frozen,nonsense'
    expect(mockScenarioFor(1)).toBe('frozen')
    expect(mockScenarioFor(2)).toBe('ok')
    expect(mockScenarioFor(3)).toBe('ok')
  })
})

// These decode real video. They need ffmpeg on PATH and are skipped without it; nothing here touches the network.
describe.skipIf(!ffmpegAvailable())('ffmpeg: a real clip, and known faults injected into it', () => {
  let dir = ''
  let file = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-test-'))
    file = join(dir, 'ball.mp4')
    // Three seconds of a white square drifting across a grey frame.
    const made = Bun.spawn(
      ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x505050:s=180x320:r=24:d=3', '-f', 'lavfi', '-i', 'color=c=white:s=44x44:r=24:d=3', '-filter_complex', "[0][1]overlay=x='10+t*40':y='120+60*sin(t*2)'", '-pix_fmt', 'yuv420p', file],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    if ((await made.exited) !== 0) throw new Error(await new Response(made.stderr).text())
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const signalsOf = async (path: string) => {
    const clip = await openClip(path)
    try {
      return analyse(clip.grey, clip.fps)
    } finally {
      clip.close()
    }
  }

  test('every frame is decoded, and the clean clip raises no alarm', async () => {
    const clip = await openClip(file)
    expect(clip.fps).toBe(24)
    expect(clip.grey).toHaveLength(72)
    expect(clip.grey[0]).toHaveLength(GRID * GRID)
    expect([clip.width, clip.height]).toEqual([180, 320])
    const s = analyse(clip.grey, clip.fps)
    expect(s.frozen).toBe(false)
    expect(s.deadStart).toBe(false)
    expect(s.moments.filter((m) => m.kind !== 'fastest')).toHaveLength(0)
    clip.close()
  })

  test('stills come out by exact frame, in the order asked, whole or zoomed', async () => {
    const clip = await openClip(file)
    const stills = await clip.stills([40, 0, 40])
    expect(stills.map((s) => s.frame)).toEqual([40, 0, 40])
    expect(stills[1]!.t).toBe(0)
    for (const s of stills) expect([s.bytes[0], s.bytes[1]]).toEqual([0xff, 0xd8])
    // Frame 0 and frame 40 are different pictures.
    expect(Buffer.from(stills[0]!.bytes).equals(Buffer.from(stills[1]!.bytes))).toBe(false)
    expect(Buffer.from(stills[0]!.bytes).equals(Buffer.from(stills[2]!.bytes))).toBe(true)
    const zoomed = await clip.stills([40], { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect([zoomed[0]!.bytes[0], zoomed[0]!.bytes[1]]).toEqual([0xff, 0xd8])
    // Out-of-range frames are clamped to the clip rather than failing.
    expect((await clip.stills([9999]))[0]!.frame).toBe(71)
    clip.close()
  })

  test('injected faults are caught by the measurements', async () => {
    const src = { frames: 72, fps: 24 }
    for (const fault of ['freeze', 'late', 'cut', 'pop', 'flash'] as const) {
      const out = join(dir, `${fault}.mp4`)
      const injected = await injectFault(file, fault, out, src)
      expect([fault, injected.caught(await signalsOf(out))]).toEqual([fault, true])
    }
  })

  test('verifyVideo opens a real file itself and measures it', async () => {
    const out = join(dir, 'freeze.mp4')
    const c = await verifyVideo({ concept, source: out, label: 'freeze', modelChecks: false })
    expect(c.signals!.frozen).toBe(true)
    expect(c.flags[0]!.flag).toBe('Frozen')
    expect(c.verdict).toBe('retry')
  })
})
