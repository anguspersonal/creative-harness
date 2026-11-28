import { config } from './config.ts'
import { callFal } from './fal.ts'
import type { MediaParams, MediaSpec } from './models.ts'
import type { Run } from './trace.ts'

// Render one piece of media. In mock mode returns a local placeholder so the loop and UI run fully offline.

export type MediaOut = { url: string; endpoint: string; ms: number; estUsd: number; kind: MediaSpec['kind'] }

/** Video renders take minutes; images and audio should not. */
const TIMEOUT_MS: Record<MediaSpec['kind'], number> = { image: 90_000, audio: 120_000, video: 360_000 }

export async function generateMedia(spec: MediaSpec, params: MediaParams, run?: Run): Promise<MediaOut> {
  const estUsd = spec.estUsd(params)

  if (config.mock) {
    await Bun.sleep(150)
    // MOCK_FAIL (see mock.ts) also matches renders, as "media.<kind>", to rehearse a failed render.
    const fail = process.env.MOCK_FAIL
    if (fail && new RegExp(fail).test(`media.${spec.kind}`)) throw new Error(`mock failure for media.${spec.kind}`)
    return { url: placeholder(`${spec.kind}: ${params.prompt}`), endpoint: `mock:${spec.endpoint}`, ms: 150, estUsd: 0, kind: spec.kind }
  }

  const res = await callFal(spec.endpoint, spec.build(params), { timeoutMs: TIMEOUT_MS[spec.kind] })
  const url = spec.pick(res.data)
  if (!url) throw new Error(`${spec.endpoint} returned no media URL: ${JSON.stringify(res.data).slice(0, 300)}`)
  run?.addSpend(estUsd)
  return { url, endpoint: spec.endpoint, ms: res.ms, estUsd, kind: spec.kind }
}

function placeholder(label: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const words = label.slice(0, 120).split(/\s+/)
  const lines: string[] = []
  for (const w of words) {
    const last = lines.at(-1)
    if (last !== undefined && (last + ' ' + w).length <= 22) lines[lines.length - 1] = `${last} ${w}`
    else lines.push(w)
  }
  const text = lines
    .slice(0, 8)
    .map((l, i) => `<text x="288" y="${420 + i * 34}" text-anchor="middle">${esc(l)}</text>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="576" height="1024" viewBox="0 0 576 1024"><rect width="576" height="1024" fill="#1a1a1a"/><g fill="#bbb" font-family="sans-serif" font-size="26">${text}</g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
