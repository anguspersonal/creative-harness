import { config } from '../config.ts'
import type { Signals } from './signals.ts'

// Known faults, put into a real clip with ffmpeg, so the verifier can be tried against clips whose
// problem is certain. This is how the thresholds in signals.ts were set, and how to check them again
// after changing one: `bun run verify-video <clip> --inject all`.

export const FAULTS = ['freeze', 'late', 'cut', 'pop', 'blip', 'flash'] as const
export type Fault = (typeof FAULTS)[number]

export type Injected = {
  fault: Fault
  /** Where the fault is, in seconds of the new clip; null when it covers the whole clip. */
  at: number | null
  describe: string
  /** Did the measurements find it? */
  caught: (s: Signals) => boolean
}

/** Write a copy of `file` with one fault added. `frames` and `fps` describe the source clip. */
export async function injectFault(file: string, fault: Fault, out: string, src: { frames: number; fps: number }): Promise<Injected> {
  const { frames, fps } = src
  const mid = Math.round(frames / 2)
  const nearMoment = (t: number) => (s: Signals) => s.moments.some((m) => m.kind !== 'fastest' && Math.abs(m.t - t) <= 2.5 / fps)
  const once = (f: number) => `enable='eq(n,${f})'`

  let filter: string
  let result: Omit<Injected, 'fault'>
  switch (fault) {
    case 'freeze':
      filter = `trim=end_frame=1,loop=loop=${frames - 1}:size=1:start=0,setpts=N/FRAME_RATE/TB`
      result = { at: null, describe: 'the first frame held for the whole clip', caught: (s) => s.frozen }
      break
    case 'late':
      filter = 'tpad=start_mode=clone:start_duration=1.5'
      result = { at: 0, describe: 'the first frame held for 1.5s before anything moves', caught: (s) => s.deadStart }
      break
    case 'cut': {
      const from = Math.round(frames * 0.4)
      const to = Math.round(frames * 0.7)
      filter = `select='lt(n,${from})+gte(n,${to})',setpts=N/FRAME_RATE/TB`
      result = { at: from / fps, describe: `frames ${from}-${to - 1} removed, so the shot jumps`, caught: nearMoment(from / fps) }
      break
    }
    case 'pop':
      filter = `drawbox=${once(mid)}:x=iw*0.55:y=ih*0.2:w=iw*0.25:h=ih*0.2:color=white:t=fill`
      result = { at: mid / fps, describe: 'a white block a quarter of the frame wide, for one frame', caught: nearMoment(mid / fps) }
      break
    case 'blip':
      filter = `drawbox=${once(mid)}:x=iw*0.3:y=ih*0.6:w=iw*0.1:h=ih*0.1:color=gray:t=fill`
      result = { at: mid / fps, describe: 'a grey block a tenth of the frame wide, for one frame (smaller than the measurements can tell from a fast-moving hand)', caught: nearMoment(mid / fps) }
      break
    case 'flash':
      filter = `eq=brightness=0.3:${once(mid)}`
      result = { at: mid / fps, describe: 'the whole frame brightens for one frame', caught: nearMoment(mid / fps) }
      break
  }

  const encode = (codec: string[]) =>
    Bun.spawn([config.ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', file, '-map', '0:v:0', '-vf', filter, ...codec, '-pix_fmt', 'yuv420p', out], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
  let proc = encode(['-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast'])
  let err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0 && /libx264|Unknown encoder/i.test(err)) {
    // ffmpeg built without x264: fall back to the encoder every build has.
    proc = encode(['-c:v', 'mpeg4', '-q:v', '2'])
    err = await new Response(proc.stderr).text()
  }
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg could not inject "${fault}": ${err.trim().slice(0, 200)}`)
  return { fault, ...result }
}
