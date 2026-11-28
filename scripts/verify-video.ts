import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { config } from '../src/config.ts'
import { verifyVideo } from '../src/harness/verifier.ts'
import type { MotionConcept, RunState, VideoCheck } from '../src/types.ts'
import { openClip } from '../src/video/clip.ts'
import { FAULTS, type Fault, injectFault } from '../src/video/inject.ts'
import { analyse, type Signals } from '../src/video/signals.ts'

// Check any clip with the video verifier, outside a run.
//
//   bun run verify-video clip.mp4                    measure every frame: no model, no key, no cost
//   bun run verify-video clip.mp4 --idea "A hand pours coffee into a cracked mug at 11pm"
//                                                    full check: measurements plus the vision-model checks (needs FAL_KEY)
//   bun run verify-video https://.../clip.mp4        a URL works anywhere a file does
//   bun run verify-video <runId>                     re-check a saved run's clips with the current rubric and prompts
//   bun run verify-video clip.mp4 --inject all       put known faults into the clip and see which ones are caught
//   bun run verify-video clip.mp4 --inject pop --idea "..."    ...and whether the model names the fault it is shown
//   --moment "..." --title "..." --hook "..."        more of the concept, for the model checks
//   --json                                           print the whole check as JSON
//
// Use --inject after changing a threshold in src/video/signals.ts or a prompt: a verifier that has not
// been tried against known faults is only an opinion.

const USAGE = 'Usage: bun run verify-video <file | url | runId> [--idea "..."] [--moment "..."] [--inject all|' + FAULTS.join('|') + '] [--json]'
const TEXT_FLAGS = ['idea', 'moment', 'title', 'hook', 'inject'] as const
const flags: Partial<Record<(typeof TEXT_FLAGS)[number], string>> = {}
let json = false
const positional: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg === '--json') json = true
  else if (arg.startsWith('--')) {
    const name = arg.slice(2) as (typeof TEXT_FLAGS)[number]
    const value = argv[++i]
    if (!TEXT_FLAGS.includes(name) || value === undefined) fail(`Unknown or incomplete flag ${arg}`)
    flags[name] = value
  } else positional.push(arg)
}
const target = positional[0]
if (!target) fail('No clip given')

const sec = (t: number) => `${t.toFixed(2)}s`
const LOOKED = { jump: 'the whole frame changed suddenly', pop: 'one area changed for a single frame', fastest: 'fastest movement' } as const

const isUrl = /^https?:\/\//i.test(target)
const runFile = join(config.runsDir, `${target.replace(/[^a-zA-Z0-9-]/g, '')}.json`)

if (isUrl || existsSync(target)) {
  if (flags.inject) await inject(target, flags.inject)
  else await check(target, basename(target), conceptFromFlags())
} else if (existsSync(runFile)) {
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as RunState
  const videos = run.renders.filter((r) => r.kind === 'video')
  if (!videos.length) fail(`Run ${run.id} has no video`)
  for (const v of videos) {
    const concept = run.concepts.find((c) => c.id === v.conceptId)
    const before = v.videoCheck ? ` (was: ${v.videoCheck.verdict}${v.videoCheck.flags.length ? `, ${v.videoCheck.flags.map((f) => f.flag).join('; ')}` : ''})` : ''
    await check(v.url, `${v.id}${before}`, concept)
  }
} else fail(`"${target}" is not a file, a URL or a saved run id`)

function conceptFromFlags(): MotionConcept | undefined {
  if (!flags.idea) return undefined
  return { title: flags.title ?? flags.idea, hook: flags.hook ?? flags.idea, idea: flags.idea, moment: flags.moment }
}

async function check(source: string, name: string, concept: MotionConcept | undefined): Promise<VideoCheck> {
  const withModel = Boolean(concept) && !config.mock
  const result = await verifyVideo({ concept: concept ?? { title: '', hook: '', idea: '' }, source, label: name, modelChecks: withModel })
  if (json) console.log(JSON.stringify(result, null, 2))
  else report(name, result, concept ? (config.mock ? 'Model checks skipped: no FAL_KEY. Measured only.' : '') : 'Measured only. Add --idea "what the clip should show" for the model checks.')
  return result
}

function report(name: string, c: VideoCheck, note: string) {
  const line = (label: string, text: string) => console.log(`  ${label.padEnd(13)} ${text}`)
  console.log(`\n${name}`)
  if (c.signals) for (const [i, t] of measured(c.signals).entries()) line(i ? '' : 'measured', t)
  if (c.hook) line('first second', `${c.hook.eventStarted ? 'an event starts' : 'nothing starts'}: ${c.hook.changes}`)
  for (const i of c.inspections) {
    const found = i.finding ? `${i.finding.kind}${i.finding.flag ? ` (${i.finding.flag})` : ''}, ${Math.round(i.finding.confidence * 100)}% sure: ${i.finding.changed}` : `not checked: ${i.error}`
    line(sec(i.t), `${LOOKED[i.kind]}${i.zoomed ? ', zoomed in' : ''} -> ${found}`)
  }
  if (c.drift) line('start to end', c.drift.consistent || !c.drift.changes.length ? 'everything stays itself' : c.drift.changes.map((d) => d.what).join('; '))
  if (c.action) line('whole clip', `${c.action.score}/10: ${c.action.beats.join(' / ')}`)
  for (const f of c.flags) line('FLAG', `${f.flag}${f.at ? ` at ${sec(f.at)}` : ''} [${f.source}]: ${f.evidence}`)
  for (const u of c.unchecked) line('not checked', u)
  const pending = c.inspections.length ? 0 : (c.signals?.moments.filter((m) => m.kind !== 'fastest').length ?? 0)
  line('verdict', c.verdict === 'pass' ? 'pass' : c.verdict === 'retry' ? 'retry' : pending ? `${pending} sudden change(s) measured but not looked at` : 'no faults found in what was checked')
  if (note) console.log(`  ${note}`)
}

function measured(s: Signals): string[] {
  const sudden = s.moments.filter((m) => m.kind !== 'fastest')
  return [
    `all ${s.frames} frames, ${s.duration}s at ${s.fps}fps`,
    `${Math.round((1 - s.stillShare) * 100)}% of frame pairs move${s.frozen ? ' (FROZEN)' : ''}, mean change ${s.meanMotion}`,
    `first second: ${Math.round(s.firstSecondStill * 100)}% still, ${s.hookRatio}x the movement of the rest${s.deadStart ? ' (DEAD START)' : s.slowStart ? ' (slow start)' : ''}; ${s.firstMoveAt === null ? 'no sustained movement' : `movement from ${sec(s.firstMoveAt)}`}`,
    `sudden changes: ${sudden.map((m) => `${m.kind} at ${sec(m.t)} (${m.ratio}x its neighbours)`).join(', ') || 'none'}`,
    `fastest: ${s.moments.filter((m) => m.kind === 'fastest').map((m) => sec(m.t)).join(', ') || 'none'}`,
  ]
}

/** Put known faults into the clip, then see whether the measurements (and, with --idea, the model) find them. */
async function inject(source: string, which: string) {
  const faults = which === 'all' ? [...FAULTS] : [which as Fault]
  if (!faults.every((f) => (FAULTS as readonly string[]).includes(f))) fail(`--inject must be "all" or one of ${FAULTS.join(', ')}`)
  const dir = mkdtempSync(join(tmpdir(), 'harness-inject-'))
  const clip = await openClip(source)
  try {
    // Work from a local copy, so a URL is downloaded once rather than once per fault.
    let file = source
    if (isUrl) {
      file = join(dir, 'source.mp4')
      await Bun.write(file, await fetch(source))
    }
    const clean = analyse(clip.grey, clip.fps)
    const alarms = [clean.frozen && 'frozen', clean.deadStart && 'dead start', ...clean.moments.filter((m) => m.kind !== 'fastest').map((m) => `${m.kind} at ${sec(m.t)}`)].filter(Boolean)
    console.log(`\n${basename(source)}: ${clean.frames} frames at ${clean.fps}fps`)
    console.log(`  as it is     ${alarms.length ? `already flagged: ${alarms.join(', ')}` : 'nothing flagged'}`)

    const concept = conceptFromFlags()
    let caught = 0
    for (const fault of faults) {
      const out = join(dir, `${fault}.mp4`)
      const injected = await injectFault(file, fault, out, { frames: clip.grey.length, fps: clip.fps })
      const faulty = await openClip(out)
      const hit = injected.caught(analyse(faulty.grey, faulty.fps))
      faulty.close()
      if (hit) caught++
      console.log(`  ${hit ? 'CAUGHT' : 'missed'} ${fault.padEnd(6)} ${injected.describe}${injected.at === null ? '' : `, at ${sec(injected.at)}`}`)
      if (concept && !config.mock) {
        const full = await verifyVideo({ concept, source: out, label: fault })
        console.log(`         verifier: ${full.verdict}${full.flags.length ? `, ${full.flags.map((f) => `${f.flag}${f.at ? ` at ${sec(f.at)}` : ''} [${f.source}]`).join('; ')}` : ''}`)
      }
    }
    console.log(`  The measurements caught ${caught} of ${faults.length}.${concept && config.mock ? ' Model checks skipped: no FAL_KEY.' : ''}`)
  } finally {
    clip.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`)
  process.exit(1)
}
