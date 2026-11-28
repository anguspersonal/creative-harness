import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.ts'
import { type Box, GRID } from './signals.ts'

// A clip, opened for measurement. The only file that runs ffmpeg.
//
// Every frame is decoded once into a GRID x GRID greyscale thumbnail (a 5s clip is about 300KB of
// numbers), which is what signals.ts measures. Full-size stills are pulled out afterwards, by exact
// frame index, only for the handful of frames the vision model is asked to look at.

export type Still = { frame: number; t: number; bytes: Uint8Array; mime: string }

export type Clip = {
  fps: number
  width: number
  height: number
  /** One thumbnail per frame, in order. */
  grey: Uint8Array[]
  /** Stills for these frame indexes, in the order asked, optionally zoomed into one area. */
  stills(frames: number[], crop?: Box): Promise<Still[]>
  /** Remove temporary files. */
  close(): void
}

/** Longer clips are measured up to this point only. */
const MAX_SECONDS = 30
const STILL_WIDTH = 512

export function ffmpegAvailable(): boolean {
  return Boolean(Bun.which(config.ffmpeg) && Bun.which(config.ffprobe))
}

/** Open a local file or an http(s) URL. Throws if ffmpeg is missing or the clip cannot be decoded. */
export async function openClip(source: string): Promise<Clip> {
  if (!ffmpegAvailable()) {
    throw new Error(`ffmpeg and ffprobe are needed to check video (looked for "${config.ffmpeg}" and "${config.ffprobe}"). Install ffmpeg, or set FFMPEG_PATH and FFPROBE_PATH.`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'harness-clip-'))
  const close = () => rmSync(dir, { recursive: true, force: true })
  try {
    let file = source
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`could not download the clip (status ${res.status})`)
      file = join(dir, 'clip.mp4')
      await Bun.write(file, res)
    }

    const probe = await run([config.ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,duration:format=duration', '-of', 'json', file])
    if (probe.code !== 0) throw new Error(`ffprobe could not read the clip: ${probe.err.trim().slice(0, 200)}`)
    const meta = JSON.parse(new TextDecoder().decode(probe.out)) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
    const stream = meta.streams?.[0]
    if (!stream) throw new Error('the file has no video stream')

    const decoded = await passthrough((mode) => [
      config.ffmpeg, '-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-t', String(MAX_SECONDS),
      '-vf', `scale=${GRID}:${GRID}:flags=area,format=gray`, ...mode, '-f', 'rawvideo', '-',
    ])
    if (decoded.code !== 0) throw new Error(`ffmpeg could not decode the clip: ${decoded.err.trim().slice(0, 200)}`)
    const size = GRID * GRID
    const count = Math.floor(decoded.out.length / size)
    if (count < 3) throw new Error(`the clip has only ${count} frame(s)`)
    const grey = Array.from({ length: count }, (_, i) => decoded.out.subarray(i * size, (i + 1) * size))

    const seconds = Number(stream.duration ?? meta.format?.duration)
    const fps = rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate) ?? (seconds > 0 ? count / Math.min(seconds, MAX_SECONDS) : 24)

    let shots = 0
    const stills = async (frames: number[], crop?: Box): Promise<Still[]> => {
      const wanted = [...new Set(frames.map((f) => Math.min(count - 1, Math.max(0, Math.round(f)))))].sort((a, b) => a - b)
      if (wanted.length === 0) return []
      const out = join(dir, `stills-${shots++}`)
      mkdirSync(out, { recursive: true })
      const select = `select='${wanted.map((f) => `eq(n,${f})`).join('+')}'`
      const zoom = crop ? `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y},scale=${STILL_WIDTH}:-2:flags=lanczos` : `scale='min(${STILL_WIDTH},iw)':-2`
      const res = await passthrough((mode) => [
        config.ffmpeg, '-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0',
        '-vf', `${select},${zoom}`, ...mode, '-frames:v', String(wanted.length), '-q:v', '4', join(out, '%03d.jpg'),
      ])
      const files = readdirSync(out).sort()
      if (res.code !== 0 || files.length !== wanted.length) {
        throw new Error(`ffmpeg wrote ${files.length} of ${wanted.length} stills: ${res.err.trim().slice(0, 200)}`)
      }
      const byFrame = new Map(wanted.map((f, i) => [f, new Uint8Array(readFileSync(join(out, files[i]!)))]))
      return frames.map((f) => {
        const frame = Math.min(count - 1, Math.max(0, Math.round(f)))
        return { frame, t: frame / fps, bytes: byFrame.get(frame)!, mime: 'image/jpeg' }
      })
    }

    return { fps, width: Number(stream.width) || 0, height: Number(stream.height) || 0, grey, stills, close }
  } catch (err) {
    close()
    throw err
  }
}

/** "24/1" or "30000/1001" -> frames per second. */
function rate(value: unknown): number | undefined {
  const [a, b] = String(value ?? '').split('/').map(Number)
  const fps = b ? a! / b : a
  return fps && Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : undefined
}

type Ran = { code: number; out: Uint8Array; err: string }

async function run(cmd: string[], timeoutMs = 120_000): Promise<Ran> {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: new Uint8Array(out), err }
  } finally {
    clearTimeout(timer)
  }
}

// Frames must come out one for one, with none dropped or repeated to fit a frame rate. ffmpeg 5.1+
// spells that "-fps_mode passthrough"; older builds only know "-vsync 0". Use whichever this one accepts.
let frameMode: string[] | undefined
async function passthrough(build: (mode: string[]) => string[]): Promise<Ran> {
  if (frameMode) return run(build(frameMode))
  const modern = await run(build(['-fps_mode', 'passthrough']))
  if (modern.code === 0 || !/fps_mode/i.test(modern.err)) {
    if (modern.code === 0) frameMode = ['-fps_mode', 'passthrough']
    return modern
  }
  const legacy = await run(build(['-vsync', '0']))
  if (legacy.code === 0) frameMode = ['-vsync', '0']
  return legacy
}

// ---- Mock clips: synthetic frames with a known fault, so the whole verifier runs offline in tests and demos.

export const MOCK_SCENARIOS = ['ok', 'frozen', 'slow', 'pop', 'cut', 'morph'] as const
export type MockScenario = (typeof MOCK_SCENARIOS)[number]

/** MOCK_VIDEO="frozen,ok" scripts the fault per attempt. By default the first attempt pops and later ones are clean, so a mock run shows a retry. */
export function mockScenarioFor(attempt: number): MockScenario {
  const scripted = process.env.MOCK_VIDEO?.split(',')[attempt - 1]?.trim()
  if (scripted && (MOCK_SCENARIOS as readonly string[]).includes(scripted)) return scripted as MockScenario
  return !process.env.MOCK_VIDEO && attempt === 1 ? 'pop' : 'ok'
}

/**
 * A bright ball crossing a gradient, 5 seconds at 24fps, with one fault chosen by name:
 * frozen (nothing moves), slow (still for 1.6s), pop (a block appears for one frame at 2.5s),
 * cut (the scene flips at 2.5s), morph (measures clean; the mock vision model reports drift).
 */
export function mockClip(scenario: MockScenario, seconds = 5, fps = 24): Clip {
  const count = Math.round(seconds * fps)
  const popFrame = Math.round(2.5 * fps)
  const scene = (frame: number) => {
    const t = frame / fps
    const moving = scenario === 'frozen' ? 0 : scenario === 'slow' ? Math.max(0, t - 1.6) : t
    const flipped = scenario === 'cut' && frame >= popFrame
    const cx = 0.18 + 0.13 * moving
    return { cx: flipped ? 1 - cx : cx, cy: 0.5 + 0.2 * Math.sin(Math.PI * moving), pop: scenario === 'pop' && frame === popFrame, flipped }
  }
  const R = 0.16
  const POP = { x: 0.58, y: 0.12, w: 0.3, h: 0.18 }
  const grey = Array.from({ length: count }, (_, frame) => {
    const s = scene(frame)
    const px = new Uint8Array(GRID * GRID)
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const u = (x + 0.5) / GRID
        const v = (y + 0.5) / GRID
        let level = s.flipped ? 190 - 110 * v : 40 + 70 * v
        // Soft edge, so sub-cell movement changes the picture on every frame as real footage does.
        const edge = Math.min(1, Math.max(0, (R - Math.hypot(u - s.cx, v - s.cy)) / 0.04 + 0.5))
        level += (235 - level) * edge
        if (s.pop && u >= POP.x && u < POP.x + POP.w && v >= POP.y && v < POP.y + POP.h) level = 255
        px[y * GRID + x] = Math.round(level)
      }
    }
    return px
  })
  const W = 576
  const H = 1024
  const stills = async (frames: number[], crop?: Box): Promise<Still[]> =>
    frames.map((f) => {
      const frame = Math.min(count - 1, Math.max(0, Math.round(f)))
      const s = scene(frame)
      const box = crop ?? { x: 0, y: 0, w: 1, h: 1 }
      const view = `${box.x * W} ${box.y * H} ${box.w * W} ${box.h * H}`
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round((W * box.h * H) / (box.w * W))}" viewBox="${view}"><!-- scenario=${scenario} -->
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.flipped ? '#bebebe' : '#282828'}"/><stop offset="1" stop-color="${s.flipped ? '#505050' : '#6e6e6e'}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/><ellipse cx="${(s.cx * W).toFixed(1)}" cy="${(s.cy * H).toFixed(1)}" rx="${R * W}" ry="${R * H}" fill="#ebebeb"/>
${s.pop ? `<rect x="${POP.x * W}" y="${POP.y * H}" width="${POP.w * W}" height="${POP.h * H}" fill="#fff"/>` : ''}
<text x="${W / 2}" y="${H - 40}" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="34">${(frame / fps).toFixed(2)}s</text></svg>`
      return { frame, t: frame / fps, bytes: new TextEncoder().encode(svg), mime: 'image/svg+xml' }
    })
  return { fps, width: W, height: H, grey, stills, close: () => {} }
}
