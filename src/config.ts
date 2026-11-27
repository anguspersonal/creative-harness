// Runtime config from env. Bun loads .env automatically.

const env = process.env

function positiveInt(name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}

export const config = {
  falKey: env.FAL_KEY ?? '',
  // Mock mode: no network, deterministic fake LLM + placeholder media.
  // On by default when there is no FAL_KEY, so the UI always runs.
  mock: env.MOCK === '1' || (!env.FAL_KEY && env.MOCK !== '0'),
  // fal starts new accounts at 2 concurrent requests. Raise once your dashboard says so.
  concurrency: positiveInt('CONCURRENCY', 2),
  port: positiveInt('PORT', 3000),
  runsDir: env.RUNS_DIR ?? 'runs',
}

/** How a field is ranked. 'auto' picks round-robin up to `roundRobinMax` contenders, Swiss above that. */
export type TournamentFormat = 'auto' | 'round-robin' | 'swiss'
export const TOURNAMENT_FORMATS: readonly TournamentFormat[] = ['auto', 'round-robin', 'swiss']

export type HarnessOptions = {
  /** How many concepts the director generates. Wider = more chance of something good. */
  concepts: number
  /** How many concepts survive the text tournament and get rendered. */
  finalists: number
  /** Max critique -> revise rounds per finalist. */
  maxIters: number
  /** Critic score (0-10) at which a finalist ships early. */
  shipScore: number
  /** Stop iterating when a revision improves the score by less than this. */
  plateau: number
  /** How many non-improving versions in a row to allow before stopping. Each retry revises from the best version so far. */
  patience: number
  /** Animate the winning image at the end (slow and costs more). */
  video: boolean
  /** Round-robin judges every pair (n(n-1)/2 matches); Swiss plays log2(n) rounds (about n log n / 2 matches). */
  tournament: TournamentFormat
  /** With tournament 'auto': fields up to this size use round-robin, larger fields use Swiss. */
  roundRobinMax: number
}

export const defaultOptions: HarnessOptions = {
  concepts: 8,
  finalists: 3,
  maxIters: 3,
  shipScore: 8.5,
  plateau: 0.5,
  patience: 1,
  video: false,
  tournament: 'auto',
  roundRobinMax: 8,
}

/** Clamp user-supplied options (UI or CLI) to sane bounds. Invalid values are dropped. */
export function sanitiseOptions(o: Partial<Record<keyof HarnessOptions, unknown>> = {}): Partial<HarnessOptions> {
  const out: Partial<HarnessOptions> = {}
  const int = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined
  const concepts = int(o.concepts, 2, 16)
  const finalists = int(o.finalists, 1, 6)
  const maxIters = int(o.maxIters, 0, 6)
  const patience = int(o.patience, 0, 3)
  const roundRobinMax = int(o.roundRobinMax, 2, 16)
  if (concepts !== undefined) out.concepts = concepts
  if (finalists !== undefined) out.finalists = finalists
  if (maxIters !== undefined) out.maxIters = maxIters
  if (patience !== undefined) out.patience = patience
  if (roundRobinMax !== undefined) out.roundRobinMax = roundRobinMax
  if (typeof o.video === 'boolean') out.video = o.video
  if (TOURNAMENT_FORMATS.includes(o.tournament as TournamentFormat)) out.tournament = o.tournament as TournamentFormat
  return out
}
