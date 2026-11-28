import { ApiError, fal } from '@fal-ai/client'
import { config } from './config.ts'
import { createLimiter } from './util/limit.ts'

// The only file that talks to fal directly. Everything goes through one limiter
// sized to your account's concurrency, so fan-out never trips 429s.

let configured = false
export const falLimit = createLimiter(config.concurrency)

export type FalResult = { data: any; requestId: string; ms: number }

export type CallOptions = {
  /** Total client-side timeout in ms. On expiry the client also cancels the job so it stops billing. */
  timeoutMs?: number
  /** Fail if fal hasn't started the job within this many seconds (queue backlog). */
  startTimeoutS?: number
}

function configure() {
  if (configured) return
  if (!config.falKey) throw new Error('FAL_KEY is not set. Add it to .env or run with MOCK=1.')
  fal.config({ credentials: config.falKey })
  configured = true
}

// Uploads are plain storage requests, not model jobs, so they do not count against the account's
// concurrency. They get a small limiter of their own so a burst of frames does not trip a rate limit.
const uploadLimit = createLimiter(4)

/** Host a small file (a frame pulled from a clip) on fal storage, so a vision model can fetch it by URL. */
export async function uploadFile(bytes: Uint8Array, contentType: string): Promise<string> {
  configure()
  return uploadLimit(() => fal.storage.upload(new Blob([new Uint8Array(bytes)], { type: contentType })))
}

export async function callFal(endpoint: string, input: Record<string, unknown>, opts: CallOptions = {}): Promise<FalResult> {
  configure()
  return falLimit(async () => {
    const t0 = performance.now()
    try {
      const res = await fal.subscribe(endpoint, {
        input,
        logs: false,
        timeout: opts.timeoutMs ?? 90_000,
        startTimeout: opts.startTimeoutS ?? 120,
      })
      return { data: res.data, requestId: res.requestId, ms: Math.round(performance.now() - t0) }
    } catch (err) {
      throw describeFalError(endpoint, err, Math.round(performance.now() - t0))
    }
  })
}

function describeFalError(endpoint: string, err: unknown, ms: number): Error {
  if (err instanceof ApiError) {
    const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body)
    const why = err.status === 504 ? 'timed out' : `status ${err.status}`
    return new Error(`fal ${endpoint} failed after ${ms}ms (${why}): ${body?.slice(0, 500)}`)
  }
  return new Error(`fal ${endpoint} failed after ${ms}ms: ${err instanceof Error ? err.message : String(err)}`)
}
