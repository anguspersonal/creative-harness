import { fal } from '@fal-ai/client'
import { config } from '../src/config.ts'
import { verifyVideo } from '../src/harness/verifier.ts'
import { complete } from '../src/llm.ts'
import { generateMedia } from '../src/media.ts'
import { LLM, SPECS, type MediaSpec } from '../src/models.ts'

// Run this on Friday with your real key. It proves every endpoint the harness uses
// works with your account, and tells you real latency and cost.
//
//   bun run smoke                    LLM text + vision, draft and final image models
//   bun run smoke --video            also the default video model and the video verifier (~$0.30, needs ffmpeg)
//   bun run smoke --all              every spec in models.ts (~$1.50)
//   bun run smoke --parallel 6       fire 6 draft renders at once to see your concurrency cap

const args = process.argv.slice(2)
const parallelIdx = args.indexOf('--parallel')
const parallel = parallelIdx >= 0 ? Number(args[parallelIdx + 1] ?? 4) : 0

if (config.mock) {
  console.error('Smoke test needs a real FAL_KEY (and MOCK unset). Add it to .env.')
  process.exit(1)
}

const PROMPT = 'A lighthouse keeper reading a paperback by torchlight, rain on the window, vertical framing, 35mm film grain'
let failures = 0

async function step(name: string, fn: () => Promise<string>) {
  const t0 = performance.now()
  try {
    const out = await fn()
    console.log(`  ok   ${name.padEnd(46)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${out}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name.padEnd(46)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${err instanceof Error ? err.message : err}`)
  }
}

console.log(`\nLLM (${LLM.textModel} / ${LLM.visionModel})`)
await step(LLM.textEndpoint, async () => (await complete({ task: 'smoke', system: 'Reply in five words or fewer.', prompt: 'Say hello.' })).trim())

let imageUrl = ''
console.log('\nImages')
await step(SPECS.fluxSchnell.endpoint, async () => {
  const r = await generateMedia(SPECS.fluxSchnell, { prompt: PROMPT })
  imageUrl = r.url
  return `~$${r.estUsd.toFixed(4)} ${r.url}`
})

if (imageUrl) {
  await step(LLM.visionEndpoint, async () =>
    (await complete({ task: 'smoke', system: 'Reply in ten words or fewer.', prompt: 'What is in this image?', imageUrls: [imageUrl] })).trim(),
  )
}

const media = (spec: MediaSpec, extra: { imageUrl?: string; seconds?: number } = {}) =>
  step(spec.endpoint, async () => {
    const r = await generateMedia(spec, { prompt: PROMPT, ...extra })
    return `~$${r.estUsd.toFixed(4)} ${r.url}`
  })

await media(SPECS.nanoBanana)

if (args.includes('--all')) {
  await media(SPECS.flux2)
  if (imageUrl) await media(SPECS.nanoBananaEdit, { imageUrl })
}

if (args.includes('--video') || args.includes('--all')) {
  console.log('\nVideo')
  let videoUrl = ''
  if (imageUrl) {
    await step(SPECS.h3TurboI2V.endpoint, async () => {
      const r = await generateMedia(SPECS.h3TurboI2V, { prompt: PROMPT, imageUrl, seconds: 5 })
      videoUrl = r.url
      return `~$${r.estUsd.toFixed(4)} ${r.url}`
    })
  }
  // The whole verifier path against your account: download, ffmpeg, frame upload, and vision calls on those frames.
  if (videoUrl) {
    await step('video verifier (ffmpeg, frame upload, vision)', async () => {
      const c = await verifyVideo({ concept: { title: 'Lighthouse keeper', hook: 'He turns the page', idea: PROMPT }, source: videoUrl, label: 'smoke' })
      if (!c.signals) throw new Error(c.unchecked.join('; '))
      if (c.unchecked.length) throw new Error(`some checks did not run: ${c.unchecked.join('; ')}`)
      const frames = c.hook ? (c.hook.frames[0]?.url.startsWith('http') ? 'frames uploaded' : 'upload failed, frames sent inline') : 'no model checks needed'
      return `${c.signals.frames} frames measured, ${frames}, verdict ${c.verdict}${c.flags.length ? ` (${c.flags.map((f) => f.flag).join('; ')})` : ''}`
    })
  }
  if (args.includes('--all')) {
    if (imageUrl) await media(SPECS.klingV4I2V, { imageUrl, seconds: 5 })
    await media(SPECS.flux3MaxT2V, { seconds: 5 })
  }
}

if (args.includes('--all')) {
  console.log('\nAudio')
  await media(SPECS.kokoro)
  await media(SPECS.lyria2)
}

if (parallel > 0) {
  // Bypasses the harness limiter on purpose, to show how fal queues over-cap requests.
  console.log(`\nConcurrency: ${parallel} simultaneous ${SPECS.fluxSchnell.endpoint} calls`)
  fal.config({ credentials: config.falKey })
  const t0 = performance.now()
  const times = await Promise.all(
    Array.from({ length: parallel }, async (_, i) => {
      const s = performance.now()
      await fal.subscribe(SPECS.fluxSchnell.endpoint, { input: SPECS.fluxSchnell.build({ prompt: `${PROMPT}, variation ${i}` }) })
      return (performance.now() - s) / 1000
    }),
  )
  times.sort((a, b) => a - b)
  console.log(`  finished in ${((performance.now() - t0) / 1000).toFixed(1)}s; per-call ${times.map((t) => t.toFixed(1)).join(', ')}s`)
  console.log('  If times step up in batches, that batch size is your concurrency cap. Set CONCURRENCY in .env to match.')
}

console.log(failures ? `\n${failures} step(s) failed. Fix the spec in src/models.ts before Saturday.` : '\nAll good.')
process.exit(failures ? 1 : 0)
