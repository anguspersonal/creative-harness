import { z } from 'zod'
import type { MomentKind, Signals } from './video/signals.ts'

// Schemas double as the contract for LLM JSON output (validated with zod).

export const ConceptSchema = z.object({
  title: z.string(),
  /** What stops the scroll in the first second. */
  hook: z.string(),
  idea: z.string(),
  /** What is actually happening in the frame. Concepts without an event came back as stock photos. */
  moment: z.string(),
  /** The axis this concept explores, so the set stays diverse (tone, format, mechanism...). */
  axis: z.string(),
  medium: z.enum(['image', 'video']),
  visualPrompt: z.string(),
  whyItWorks: z.string(),
})
export type ConceptDraft = z.infer<typeof ConceptSchema>
export type Concept = ConceptDraft & { id: string; status: 'pending' | 'eliminated' | 'finalist' | 'winner' }
/** The parts of a concept the video checks need. A saved run's concept fits; so does a hand-written one. */
export type MotionConcept = Pick<Concept, 'title' | 'hook' | 'idea'> & { moment?: string }

export const DivergeSchema = z.object({
  /** The obvious images for the category, listed first so the director can refuse them. */
  cliches: z.array(z.string()).default([]),
  concepts: z.array(ConceptSchema).min(1),
})

export const CompareSchema = z.object({
  winner: z.enum(['A', 'B']),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
})
export type Compare = z.infer<typeof CompareSchema>

export const CritiqueSchema = z.object({
  score: z.number().min(0).max(10),
  slop: z.array(z.object({ flag: z.string(), evidence: z.string() })),
  strengths: z.array(z.string()),
  fixes: z.array(z.string()),
  // Critics occasionally omit the verdict; defaulting beats dropping a finalist (seen in a live run). Slop still blocks shipping.
  verdict: z.enum(['ship', 'revise', 'kill']).default('revise'),
})
export type Critique = z.infer<typeof CritiqueSchema>

export const ReviseSchema = z.object({
  visualPrompt: z.string(),
  changeSummary: z.string(),
})
export type Revision = z.infer<typeof ReviseSchema>

// ---- Video verification. Each check asks a vision model one narrow question about chosen frames.

/** Frames from the first second: has anything started? */
export const HookCheckSchema = z.object({
  changes: z.string(),
  eventStarted: z.boolean(),
})
export type HookCheck = z.infer<typeof HookCheckSchema>

/** Frames around a moment the measurements singled out: real movement, a cut, or a generation fault? */
export const InspectSchema = z.object({
  changed: z.string(),
  kind: z.enum(['motion', 'cut', 'fault']),
  /** Which motion slop flag from rubric.video.md, when kind is "fault". */
  flag: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type InspectFinding = z.infer<typeof InspectSchema>

const NotedSchema = z.object({ what: z.string(), evidence: z.string().default('') })

/** First, middle and last frame: is everything still itself? */
export const DriftCheckSchema = z.object({
  consistent: z.boolean(),
  changes: z.array(NotedSchema).default([]),
})
export type DriftCheck = z.infer<typeof DriftCheckSchema>

/** Frames across the whole clip: what happens, and is it the concept's moment? */
export const ActionCheckSchema = z.object({
  beats: z.array(z.string()).default([]),
  sceneChanges: z.boolean(),
  deliversMoment: z.boolean(),
  impossible: z.array(NotedSchema).default([]),
  score: z.number().min(0).max(10),
  fixes: z.array(z.string()).default([]),
})
export type ActionCheck = z.infer<typeof ActionCheckSchema>

export const MotionReviseSchema = z.object({
  motionPrompt: z.string(),
  changeSummary: z.string(),
})
export type MotionRevision = z.infer<typeof MotionReviseSchema>

/** A still pulled from the clip and shown to the model, kept so the UI can show what was looked at. */
export type FrameRef = { t: number; url: string }

export type VideoFlag = {
  flag: string
  evidence: string
  /** Seconds into the clip, when the problem is at one moment. */
  at?: number
  /** Measured from the pixels in code, or reported by the vision model. */
  source: 'measured' | 'model'
}

export type Inspection = {
  t: number
  kind: MomentKind
  ratio: number
  /** True when the frames were zoomed into the area that changed. */
  zoomed: boolean
  frames: FrameRef[]
  /** The whole frame at this moment, shown alongside zoomed frames for context. */
  context?: FrameRef
  finding?: InspectFinding
  error?: string
}

export type VideoCheck = {
  /** Absent only when the clip could not be read. */
  signals?: Signals
  hook?: HookCheck & { frames: FrameRef[] }
  inspections: Inspection[]
  drift?: DriftCheck & { frames: FrameRef[] }
  action?: ActionCheck & { frames: FrameRef[] }
  flags: VideoFlag[]
  /** The whole-clip motion score, when that check ran. */
  score?: number
  /** pass: every check ran and found nothing. retry: at least one flag. unchecked: some checks could not run and the rest found nothing. */
  verdict: 'pass' | 'retry' | 'unchecked'
  /** Checks that could not run, and why. */
  unchecked: string[]
}

export type MediaKind = 'image' | 'video' | 'audio'

export type Render = {
  id: string
  conceptId: string
  version: number
  kind: MediaKind
  url: string
  prompt: string
  endpoint: string
  ms: number
  estUsd: number
  critique?: Critique
  /** Set on video renders once the verifier has looked at them. */
  videoCheck?: VideoCheck
  changeSummary?: string
  /** A revision the critic judged unworkable; never used as a base or a winner. */
  discarded?: boolean
}

export type Match = {
  round: string
  a: string
  b: string
  winner: string
  reason: string
  /** False when swapping A/B changed the verdict: the judge was biased by order, not content. */
  consistent: boolean
}

export type Stage = 'brief' | 'diverge' | 'select' | 'draft' | 'critique' | 'revise' | 'showdown' | 'final' | 'verify' | 'done' | 'error'

export type TraceEvent = { t: number; stage: Stage; message: string; data?: unknown }

export type RunState = {
  id: string
  brief: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  options: Record<string, unknown>
  concepts: Concept[]
  matches: Match[]
  renders: Render[]
  final?: { conceptId: string; image?: Render; video?: Render; reason: string }
  spend: { usd: number; calls: number }
  events: TraceEvent[]
  error?: string
}
