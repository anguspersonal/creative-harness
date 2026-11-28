import { config } from '../config.ts'
import { uploadFile } from '../fal.ts'
import { completeJson } from '../llm.ts'
import {
  actionCheckPrompt,
  driftCheckPrompt,
  type FailedMotion,
  hookCheckPrompt,
  inspectPrompt,
  MOTION_REVISER_SYSTEM,
  motionRevisePrompt,
  VERIFIER_SYSTEM,
} from '../prompts.ts'
import type { Run } from '../trace.ts'
import {
  ActionCheckSchema,
  DriftCheckSchema,
  type FrameRef,
  HookCheckSchema,
  InspectSchema,
  type Inspection,
  type MotionConcept,
  MotionReviseSchema,
  type MotionRevision,
  type VideoCheck,
  type VideoFlag,
} from '../types.ts'
import { type Clip, openClip, type Still } from '../video/clip.ts'
import { analyse, type Moment, pickMoments, type Signals } from '../video/signals.ts'

// Video verifier. Built around two facts:
//
// 1. A vision model sees a video as a few stills a second. Timing, stillness and anything that lasts a
//    frame or two are invisible to it. So those are MEASURED, on every frame, in code (video/signals.ts).
// 2. Generated video breaks in time, not in any one frame: things pop in, melt, drift into something else,
//    or the shot jumps. A model can see that, but only if it is shown the right neighbouring frames, close
//    up. So the measurements choose the frames and the area, and the model answers one narrow question
//    about each. Nothing here asks a model "is this video good?".
//
// The verdict is then put together in code from those answers, the same way normaliseCritique does for stills.

export type VerifyInput = {
  concept: MotionConcept
  /** A local file or an http(s) URL. Not read when `clip` is given. */
  source: string
  /** Name used in trace events, e.g. the render id. */
  label: string
  /** An already-open clip (mock mode and tests). The caller closes it. */
  clip?: Clip
  /** False measures the clip without calling a model. */
  modelChecks?: boolean
}

/** A fault the model is unsure of is shown in the trace but does not block the clip. */
const MIN_CONFIDENCE = 0.5

/** Check one clip. Never throws: whatever could not be checked is listed in `unchecked`. */
export async function verifyVideo(input: VerifyInput, run?: Run): Promise<VideoCheck> {
  const { concept, label } = input
  const say = (message: string, data?: unknown) => run?.emit('verify', `${label}: ${message}`, data)
  const done = (check: VideoCheck) => {
    say(describeVerdict(check))
    return check
  }

  let clip: Clip
  try {
    clip = input.clip ?? (await openClip(input.source))
  } catch (err) {
    run?.emit('error', `${label}: video not checked: ${text(err)}`)
    return { inspections: [], flags: [], verdict: 'unchecked', unchecked: [`the clip could not be read: ${text(err)}`] }
  }

  try {
    const signals = analyse(clip.grey, clip.fps)
    say(describeSignals(signals))
    // Nothing moves: there is nothing for a model to look at, so do not pay one to confirm it.
    if (signals.frozen) return done(assessVideo({ signals, inspections: [], unchecked: [] }))
    if (input.modelChecks === false) return done(assessVideo({ signals, inspections: [], unchecked: ['model checks were switched off'] }))

    const unchecked: string[] = []
    const failed = (what: string, err: unknown) => {
      unchecked.push(`${what}: ${text(err)}`)
      run?.emit('error', `${label}: ${what} not checked: ${text(err)}`)
    }

    const last = signals.frames - 1
    const clamp = (f: number) => Math.min(last, Math.max(0, Math.round(f)))
    const hookFrames = unique([0, 0.25, 0.5, 0.75, 1].map((t) => clamp(t * clip.fps)))
    const driftFrames = unique([0, clamp(last / 2), last])
    const actionFrames = unique(Array.from({ length: 8 }, (_, i) => clamp((i * last) / 7)))
    const moments = pickMoments(signals)
    // A sudden change is judged on the frames either side of it; fast movement on frames a fifth of a second apart.
    const around = (m: Moment) => {
      const step = m.kind === 'fastest' ? Math.max(1, Math.round(clip.fps * 0.2)) : 1
      return unique([m.frame - step, m.frame, m.frame + step].map(clamp))
    }

    const whole = new Map<number, FrameRef>()
    try {
      const stills = await clip.stills(unique([...hookFrames, ...driftFrames, ...actionFrames, ...moments.flatMap(around)]))
      const urls = await Promise.all(stills.map(host))
      stills.forEach((s, i) => whole.set(s.frame, { t: round(s.t), url: urls[i]! }))
    } catch (err) {
      failed('frames could not be pulled from the clip', err)
      return done(assessVideo({ signals, inspections: [], unchecked }))
    }
    const refs = (frames: number[]) => frames.map((f) => whole.get(f)!)
    const ask = { system: VERIFIER_SYSTEM, temperature: 0.2 }

    const hook = (async () => {
      try {
        const frames = refs(hookFrames)
        const r = await completeJson({ ...ask, task: 'video.hook', prompt: hookCheckPrompt(concept, frames.map((f) => f.t), signals), imageUrls: frames.map((f) => f.url), maxTokens: 400 }, HookCheckSchema, run)
        say(`first second: ${r.eventStarted ? 'an event starts' : 'nothing starts'} (${r.changes})`)
        return { ...r, frames }
      } catch (err) {
        failed('first second', err)
        return undefined
      }
    })()

    const inspections = Promise.all(
      moments.map(async (m): Promise<Inspection> => {
        const inspection: Inspection = { t: m.t, kind: m.kind, ratio: m.ratio, zoomed: false, frames: refs(around(m)) }
        try {
          if (m.region) {
            const zoomed = await clip.stills(around(m), m.region)
            const urls = await Promise.all(zoomed.map(host))
            inspection.frames = zoomed.map((s, i) => ({ t: round(s.t), url: urls[i]! }))
            inspection.context = whole.get(clamp(m.frame))
            inspection.zoomed = true
          }
          const shown = inspection.context ? [...inspection.frames, inspection.context] : inspection.frames
          inspection.finding = await completeJson(
            { ...ask, task: 'video.inspect', prompt: inspectPrompt(concept, m, inspection.frames.map((f) => f.t), inspection.zoomed), imageUrls: shown.map((f) => f.url), maxTokens: 400 },
            InspectSchema,
            run,
          )
          say(`${m.t.toFixed(2)}s (${LOOKED[m.kind]}${inspection.zoomed ? ', zoomed in' : ''}): ${inspection.finding.kind}. ${inspection.finding.changed}`)
        } catch (err) {
          inspection.error = text(err)
          failed(`the moment at ${m.t.toFixed(2)}s`, err)
        }
        return inspection
      }),
    )

    const drift = (async () => {
      try {
        const frames = refs(driftFrames)
        const r = await completeJson({ ...ask, task: 'video.drift', prompt: driftCheckPrompt(concept, frames.map((f) => f.t)), imageUrls: frames.map((f) => f.url), maxTokens: 500 }, DriftCheckSchema, run)
        say(`start to end: ${r.consistent || !r.changes.length ? 'everything stays itself' : r.changes.map((c) => c.what).join('; ')}`)
        return { ...r, frames }
      } catch (err) {
        failed('start-to-end comparison', err)
        return undefined
      }
    })()

    const action = (async () => {
      try {
        const frames = refs(actionFrames)
        const r = await completeJson({ ...ask, task: 'video.action', prompt: actionCheckPrompt(concept, frames.map((f) => f.t)), imageUrls: frames.map((f) => f.url), maxTokens: 800 }, ActionCheckSchema, run)
        say(`whole clip: ${r.score}/10. ${r.beats.join(' / ')}`)
        return { ...r, frames }
      } catch (err) {
        failed('whole-clip check', err)
        return undefined
      }
    })()

    return done(assessVideo({ signals, hook: await hook, inspections: await inspections, drift: await drift, action: await action, unchecked }))
  } finally {
    if (!input.clip) clip.close()
  }
}

/**
 * Turn measurements and model answers into flags and a verdict. The rules live here, in code:
 * - Measurements outrank the model on timing. A frozen clip or a dead first second is flagged whatever a model says.
 * - A model's fault needs a description and at least MIN_CONFIDENCE. An empty or hedged claim is not a flag.
 * - Any flag means retry. No flags but a check that could not run means unchecked, never pass.
 */
export function assessVideo(parts: Pick<VideoCheck, 'signals' | 'hook' | 'inspections' | 'drift' | 'action' | 'unchecked'>): VideoCheck {
  const { signals: s, hook, inspections, drift, action } = parts
  const flags: VideoFlag[] = []
  const share = (v: number) => `${Math.round(v * 100)}%`

  if (s?.frozen) {
    flags.push({ flag: 'Frozen', evidence: `${share(s.stillShare)} of the clip shows no change from one frame to the next`, source: 'measured' })
    return { ...parts, flags, score: 0, verdict: 'retry' }
  }
  if (s?.deadStart) {
    const starts = s.firstMoveAt === null ? 'nothing moves for long enough to see' : `movement starts at ${s.firstMoveAt.toFixed(2)}s`
    flags.push({ flag: 'Dead first second', evidence: `${share(s.firstSecondStill)} of the first second shows no change; ${starts}`, at: 0, source: 'measured' })
  } else if (hook && !hook.eventStarted) {
    const measured = s?.slowStart ? ` (measured: the first second has ${s.hookRatio}x the movement of the rest)` : ''
    flags.push({ flag: 'Dead first second', evidence: `${hook.changes}${measured}`, at: 0, source: 'model' })
  }

  for (const i of inspections) {
    const f = i.finding
    if (!f || f.kind === 'motion' || f.confidence < MIN_CONFIDENCE || !f.changed.trim()) continue
    if (f.kind === 'cut') flags.push({ flag: 'Unintended cut', evidence: f.changed, at: i.t, source: 'model' })
    else flags.push({ flag: flagName(f.flag) || (i.kind === 'fastest' ? 'Morphing' : 'Pop or flicker'), evidence: f.changed, at: i.t, source: 'model' })
  }

  // Models sometimes answer "not consistent" and then list nothing. A claim with no evidence is not a flag.
  if (drift && !drift.consistent) {
    for (const c of drift.changes.filter((c) => c.what.trim()).slice(0, 2)) flags.push({ flag: 'Identity drift', evidence: noted(c), source: 'model' })
  }

  if (action) {
    if (!action.sceneChanges) flags.push({ flag: 'Only the camera moves', evidence: action.beats.join(' / ') || 'nothing in the scene changes', source: 'model' })
    if (!action.deliversMoment) flags.push({ flag: 'Motion misses the idea', evidence: action.beats.join(' / ') || 'the movement is not the concept\'s moment', source: 'model' })
    for (const c of action.impossible.filter((c) => c.what.trim()).slice(0, 2)) flags.push({ flag: 'Impossible motion', evidence: noted(c), source: 'model' })
  }

  const verdict = flags.length ? 'retry' : parts.unchecked.length ? 'unchecked' : 'pass'
  return { ...parts, flags, score: action?.score, verdict }
}

/** Rewrite the motion prompt from what the verifier found, so the next attempt fails differently or not at all. */
export async function reviseMotion(concept: MotionConcept, prompt: string, check: VideoCheck, tried: FailedMotion[] = [], run?: Run): Promise<MotionRevision> {
  return completeJson(
    { task: 'video.revise', system: MOTION_REVISER_SYSTEM, prompt: motionRevisePrompt(concept, prompt, check.flags, check.action?.fixes ?? [], tried), temperature: 0.6, maxTokens: 400 },
    MotionReviseSchema,
    run,
  )
}

/** The number video attempts are ranked by: the motion score minus a point per flag, as effectiveScore does for stills. */
export function videoScore(check: VideoCheck): number {
  return (check.score ?? 0) - check.flags.length
}

/** Is `a` the better clip to keep? A clip with no flags beats a flagged one; then the higher videoScore. */
export function betterVideo(a: VideoCheck, b: VideoCheck): boolean {
  const clean = (c: VideoCheck) => (c.verdict === 'retry' ? 0 : 1)
  return clean(a) !== clean(b) ? clean(a) > clean(b) : videoScore(a) > videoScore(b)
}

const LOOKED: Record<Moment['kind'], string> = {
  jump: 'the whole frame changed suddenly',
  pop: 'one area changed for a single frame',
  fastest: 'fastest movement',
}

function describeSignals(s: Signals): string {
  const sudden = s.moments.filter((m) => m.kind !== 'fastest')
  const start = s.firstMoveAt === null ? 'no sustained movement' : `movement from ${s.firstMoveAt.toFixed(2)}s`
  return `measured all ${s.frames} frames (${s.duration}s at ${s.fps}fps): ${Math.round((1 - s.stillShare) * 100)}% of them move, ${start}, ${sudden.length ? `${sudden.length} sudden change(s) at ${sudden.map((m) => `${m.t.toFixed(2)}s`).join(', ')}` : 'no sudden changes'}`
}

export function describeVerdict(c: VideoCheck): string {
  const flags = c.flags.map((f) => `${f.flag}${f.at ? ` at ${f.at.toFixed(2)}s` : ''}`).join('; ')
  const score = c.score === undefined ? '' : ` ${c.score}/10${c.flags.length ? ` - ${c.flags.length} = ${videoScore(c)}` : ''},`
  if (c.verdict === 'retry') return `verdict:${score} retry (${flags})`
  if (c.verdict === 'unchecked') return `verdict:${score} not fully checked (${c.unchecked.join('; ').slice(0, 200)})`
  return `verdict:${score} pass, no faults found`
}

/** Frames go to fal storage so the vision model can fetch them. Mock stills, and any upload that fails, are inlined. */
async function host(still: Still): Promise<string> {
  if (still.mime === 'image/svg+xml') return `data:image/svg+xml;utf8,${encodeURIComponent(new TextDecoder().decode(still.bytes))}`
  const inline = () => `data:${still.mime};base64,${Buffer.from(still.bytes).toString('base64')}`
  if (config.mock) return inline()
  try {
    return await uploadFile(still.bytes, still.mime)
  } catch {
    return inline()
  }
}

/** "Pop or flicker: ..." -> "Pop or flicker". Models often append their evidence to the flag name. */
function flagName(flag: string): string {
  return flag.split(':')[0]!.trim().slice(0, 40)
}

const noted = (c: { what: string; evidence: string }) => (c.evidence.trim() ? `${c.what} (${c.evidence})` : c.what)
const unique = (xs: number[]) => [...new Set(xs)]
const round = (v: number) => Math.round(v * 100) / 100
const text = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200)
