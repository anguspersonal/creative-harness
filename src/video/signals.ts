// Measurements on every frame of a clip. Plain arithmetic on tiny greyscale copies: no model is involved,
// so these numbers cost nothing, do not drift between runs, and cover what a vision model cannot see in
// a handful of sampled stills: timing, stillness, and changes that last one or two frames.
//
// What this cannot see: whether a change is a hand moving or a hand melting. That needs eyes. So the
// measurements do two jobs: they settle the timing questions outright, and they tell the vision model
// exactly which frames and which area to look at (see harness/verifier.ts).

/** Every frame is compared as a GRID x GRID greyscale thumbnail. Averaging this hard removes compression noise. */
export const GRID = 48

/**
 * Units are grey levels (0-255) of mean change between two consecutive thumbnails.
 * Calibrated on real generated clips and on faults injected into them (see `bun run verify-video --inject`).
 * Tune here, then re-run that script: it reports what each change catches and what it falsely flags.
 */
export const THRESHOLDS = {
  /** Below this, nothing visibly changed between two frames. */
  still: 0.3,
  /** At or below this the frame is a repeat of the previous one (frame-rate padding), not evidence of a calm baseline. */
  duplicate: 0.02,
  /** This share of still frame pairs across the clip means nothing moves. */
  frozenShare: 0.9,
  /** This share of still frame pairs in the first second means the clip starts dead. */
  deadStartShare: 0.9,
  /** The first second counts as slow when it holds less than this fraction of the later motion. */
  slowStartRatio: 0.35,
  /** A frame pair is a jump when it changes this many times more than its neighbours on both sides... */
  jumpRatio: 4,
  /** ...and by at least this much in absolute terms. */
  jumpFloor: 2,
  /** A cell "pops" when one frame differs from BOTH its neighbours by this many grey levels in the same direction. */
  popLevel: 24,
  /** Popped cells are counted inside the densest square this many cells wide (a quarter of the frame). */
  popWindow: 12,
  /** A frame is a pop when this many cells pop inside that square (40 of 144)... */
  popCells: 40,
  /** ...and that is this many times more than in the frames around it. A fast limb alone reaches about 20. */
  popRatio: 3,
  /** Frame pairs on each side used as the baseline (the immediate neighbour is skipped). */
  window: 8,
  /** How many cells make up the "most-changed" average used to find fast movement in one area. */
  topCells: 16,
  /** That average must reach this many grey levels before the area counts as moving at all. */
  localFloor: 8,
  /** How many moments are handed to the vision model. */
  maxMoments: 3,
} as const

/** A region of the frame, as fractions of its width and height. */
export type Box = { x: number; y: number; w: number; h: number }

export type MomentKind = 'jump' | 'pop' | 'fastest'

/** A point in the clip the measurements single out for a closer look. */
export type Moment = {
  /** Index of the first frame after the change (for 'fastest', the frame at the peak). */
  frame: number
  /** Seconds from the start. */
  t: number
  kind: MomentKind
  /** How many times larger the change is than the frames around it (for 'fastest', than the clip's median). */
  ratio: number
  /** Where in the frame the change is, when it is confined to one area. */
  region?: Box
}

export type Signals = {
  frames: number
  fps: number
  duration: number
  /** Mean change between each frame and the next: frames - 1 values. */
  motion: number[]
  meanMotion: number
  /** Share of frame pairs with no visible change. */
  stillShare: number
  frozen: boolean
  /** Share of frame pairs in the first second with no visible change. */
  firstSecondStill: number
  /** Motion in the first second divided by motion in the rest of the clip. 1 means an even start. */
  hookRatio: number
  /** Seconds until movement first holds for three frames in a row; null if it never does. */
  firstMoveAt: number | null
  deadStart: boolean
  slowStart: boolean
  /** Every sudden change found, strongest first within each kind, plus the fastest stretches. */
  moments: Moment[]
  /** Change between the first and last frame. Near zero means the clip ends where it began. */
  endDrift: number
}

/** Mean change over all cells, and over the most-changed cells only. */
export function pairDiff(a: Uint8Array, b: Uint8Array): { mean: number; local: number } {
  const top = new Float64Array(THRESHOLDS.topCells)
  let min = 0
  let minAt = 0
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    sum += d
    if (d > min) {
      top[minAt] = d
      min = Infinity
      for (let k = 0; k < top.length; k++) {
        if (top[k]! < min) {
          min = top[k]!
          minAt = k
        }
      }
    }
  }
  let local = 0
  for (const v of top) local += v
  return { mean: sum / a.length, local: local / top.length }
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/**
 * Frame pairs that change far more than the pairs on BOTH sides of them: an impulse, not a step.
 * Movement that starts or stops is a step (one side stays high), so it is not reported; a cut, a pop
 * or a one-frame glitch is an impulse. Repeated frames are left out of the baseline so that padded
 * frame rates (every frame shown twice) do not make ordinary movement look like a string of jumps.
 */
export function impulses(curve: number[], ratio: number, floor: number): Array<{ pair: number; ratio: number }> {
  const { window: w, duplicate } = THRESHOLDS
  const baseline = (from: number, to: number): number | undefined => {
    const all: number[] = []
    for (let q = Math.max(0, from); q <= Math.min(curve.length - 1, to); q++) all.push(curve[q]!)
    if (all.length === 0) return undefined
    const moving = all.filter((v) => v > duplicate)
    // A side that is all repeats is genuinely still; a side with only a stray value or two is treated the same.
    return moving.length >= Math.max(2, all.length / 4) ? median(moving) : 0
  }
  const found: Array<{ pair: number; ratio: number }> = []
  for (let p = 0; p < curve.length; p++) {
    const v = curve[p]!
    if (v < floor) continue
    const before = baseline(p - w, p - 2)
    const after = baseline(p + 2, p + w)
    if (before === undefined && after === undefined) continue
    // floor / ratio keeps the test meaningful in a still clip: anything over the floor is then an impulse.
    const base = Math.max(before ?? 0, after ?? 0, floor / ratio)
    if (v / base >= ratio) found.push({ pair: p, ratio: v / base })
  }
  // A one-frame glitch changes twice (in, then out). Report it once, at the first change.
  const merged: Array<{ pair: number; ratio: number }> = []
  for (const f of found) {
    const last = merged.at(-1)
    if (last && f.pair - last.pair <= 2) last.ratio = Math.max(last.ratio, f.ratio)
    else merged.push({ ...f })
  }
  return merged
}

/**
 * For each frame, how many cells in its densest popWindow-wide square differ from both the frame before
 * and the frame after, in the same direction. Movement changes a cell and leaves it changed; something
 * that is there for one frame and gone the next shows up here and almost nowhere else.
 *
 * Only the densest square is counted because camera shake also flips cells for a frame, but all over the
 * picture. On a shaky action clip the whole-frame count pointed at shake; the densest square pointed at
 * an object arriving from nowhere. Index 0 and the last index are always 0.
 */
export function popCounts(grey: Uint8Array[]): number[] {
  const win = THRESHOLDS.popWindow
  const side = GRID + 1
  const sum = new Int32Array(side * side)
  const out = new Array<number>(grey.length).fill(0)
  for (let f = 1; f + 1 < grey.length; f++) {
    const a = grey[f - 1]!
    const b = grey[f]!
    const c = grey[f + 1]!
    // Summed-area table of popped cells, so every square is counted in constant time.
    for (let y = 0; y < GRID; y++) {
      let row = 0
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x
        const hi = Math.max(a[i]!, c[i]!)
        const lo = Math.min(a[i]!, c[i]!)
        if (b[i]! - hi >= THRESHOLDS.popLevel || lo - b[i]! >= THRESHOLDS.popLevel) row++
        sum[(y + 1) * side + x + 1] = sum[y * side + x + 1]! + row
      }
    }
    let best = 0
    for (let y = 0; y + win <= GRID; y++) {
      for (let x = 0; x + win <= GRID; x++) {
        const n = sum[(y + win) * side + x + win]! - sum[y * side + x + win]! - sum[(y + win) * side + x]! + sum[y * side + x]!
        if (n > best) best = n
      }
    }
    out[f] = best
  }
  return out
}

/** The area that changed between two frames, when the change is confined to part of the frame. */
export function changedRegion(a: Uint8Array, b: Uint8Array): Box | undefined {
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!))
  if (max < 12) return undefined
  const cut = Math.max(12, max * 0.4)
  let x0 = GRID
  let y0 = GRID
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (Math.abs(a[y * GRID + x]! - b[y * GRID + x]!) < cut) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  if (x1 < 0) return undefined
  // More than half the frame changed: there is no "area" to zoom into.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > (GRID * GRID) / 2) return undefined
  // Pad for context, and never zoom tighter than a third of the frame.
  const span = (lo: number, hi: number): [number, number] => {
    const size = Math.min(GRID, Math.max(hi - lo + 1 + 6, GRID / 3))
    const start = Math.min(Math.max(0, (lo + hi + 1) / 2 - size / 2), GRID - size)
    return [start / GRID, size / GRID]
  }
  const [x, w] = span(x0, x1)
  const [y, h] = span(y0, y1)
  // Once padded, a zoom that still shows most of the frame adds nothing over the frame itself.
  if (w * h > 0.6) return undefined
  return { x: round(x, 3), y: round(y, 3), w: round(w, 3), h: round(h, 3) }
}

export function analyse(grey: Uint8Array[], fps: number): Signals {
  const T = THRESHOLDS
  const n = grey.length
  const motion: number[] = []
  const local: number[] = []
  for (let i = 0; i + 1 < n; i++) {
    const d = pairDiff(grey[i]!, grey[i + 1]!)
    motion.push(d.mean)
    local.push(d.local)
  }
  const pairs = motion.length
  const timeOf = (frame: number) => frame / fps
  const stillShare = pairs ? motion.filter((v) => v < T.still).length / pairs : 1
  const frozen = stillShare >= T.frozenShare

  // Pair p is the change into frame p + 1, so the first second holds the pairs that end by 1.0s.
  const firstPairs = Math.min(pairs, Math.max(1, Math.round(fps)))
  const first = motion.slice(0, firstPairs)
  const rest = motion.slice(firstPairs)
  const firstSecondStill = first.length ? first.filter((v) => v < T.still).length / first.length : 1
  const hookRatio = rest.length && mean(rest) > 0 ? mean(first) / mean(rest) : 1
  let firstMoveAt: number | null = null
  for (let p = 0; p + 2 < pairs; p++) {
    if (motion[p]! >= T.still && motion[p + 1]! >= T.still && motion[p + 2]! >= T.still) {
      firstMoveAt = timeOf(p)
      break
    }
  }
  const deadStart = !frozen && firstSecondStill >= T.deadStartShare
  const slowStart = !frozen && !deadStart && hookRatio < T.slowStartRatio

  const moments: Moment[] = []
  const near = (frame: number, gap: number) => moments.some((m) => Math.abs(m.frame - frame) <= gap)
  const sudden = (found: Array<{ pair: number; ratio: number }>, kind: MomentKind) => {
    for (const f of [...found].sort((a, b) => b.ratio - a.ratio)) {
      const frame = f.pair + 1
      if (near(frame, 2)) continue
      moments.push({ frame, t: timeOf(frame), kind, ratio: round(f.ratio, 1), region: changedRegion(grey[f.pair]!, grey[frame]!) })
    }
  }
  if (!frozen) {
    sudden(impulses(motion, T.jumpRatio, T.jumpFloor), 'jump')
    // popCounts is indexed by frame; impulses() reports pair p as frame p + 1, so shift by one.
    sudden(impulses(popCounts(grey).slice(1), T.popRatio, T.popCells), 'pop')

    // The fastest stretches: where generated video is most likely to break, and least likely to be
    // sampled. One by movement in a single area (a limb, an object), one by movement of the whole frame.
    const typical = median(motion.filter((v) => v > T.duplicate))
    const apart = Math.max(3, Math.round(fps * 0.6))
    const step = Math.max(1, Math.round(fps * 0.2))
    const smooth = (curve: number[]) => curve.map((_, p) => mean(curve.slice(Math.max(0, p - 2), p + 3)))
    // `floor` is the level, in the curve's own units, below which there is no movement worth a look.
    const fastest = (curve: number[], floor: number) => {
      const peaks = smooth(curve)
        .map((v, p) => ({ v, p }))
        .sort((a, b) => b.v - a.v)
      for (const { v, p } of peaks) {
        const frame = p + 1
        if (v < floor) break
        if (near(frame, apart)) continue
        const region = changedRegion(grey[Math.max(0, frame - step)]!, grey[Math.min(n - 1, frame + step)]!)
        moments.push({ frame, t: timeOf(frame), kind: 'fastest', ratio: round(typical > 0 ? motion[p]! / typical : 1, 1), region })
        return
      }
    }
    fastest(local, T.localFloor)
    fastest(motion, T.still * 2)
  }

  return {
    frames: n,
    fps: round(fps, 3),
    duration: round(n / fps, 2),
    motion: motion.map((v) => round(v, 2)),
    meanMotion: round(mean(motion), 2),
    stillShare: round(stillShare, 3),
    frozen,
    firstSecondStill: round(firstSecondStill, 3),
    hookRatio: round(hookRatio, 2),
    firstMoveAt: firstMoveAt === null ? null : round(firstMoveAt, 2),
    deadStart,
    slowStart,
    moments: moments.map((m) => ({ ...m, t: round(m.t, 2) })),
    endDrift: n > 1 ? round(pairDiff(grey[0]!, grey[n - 1]!).mean, 2) : 0,
  }
}

/** The moments worth a model call: sudden changes first (strongest first), then the fastest stretches. In time order. */
export function pickMoments(signals: Signals, max: number = THRESHOLDS.maxMoments): Moment[] {
  const rank: Record<MomentKind, number> = { jump: 0, pop: 1, fastest: 2 }
  return [...signals.moments]
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.ratio - a.ratio)
    .slice(0, max)
    .sort((a, b) => a.t - b.t)
}

function round(v: number, places: number) {
  const k = 10 ** places
  return Math.round(v * k) / k
}
