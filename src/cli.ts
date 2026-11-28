import { readFileSync } from 'node:fs'
import { config, defaultOptions, sanitiseOptions, TOURNAMENT_FORMATS, type TournamentFormat } from './config.ts'
import { runHarness } from './harness/loop.ts'
import { Run } from './trace.ts'
import { ffmpegAvailable } from './video/clip.ts'

// bun run harness "your brief"            run on a brief string
// bun run harness briefs/example.md       run on a brief file
// bun run harness briefs/example.md --video --concepts 6 --finalists 2 --iters 2
// bun run harness briefs/example.md --tournament swiss        (auto | round-robin | swiss)
// bun run harness briefs/example.md --video --video-attempts 3   (each clip is checked; a flagged one is retried)

const USAGE = 'Usage: bun run harness "<brief>" | <brief-file> [--video] [--concepts N] [--finalists K] [--iters N] [--patience N] [--video-attempts N] [--motion-test N] [--tournament auto|round-robin|swiss] [--round-robin-max N]'
const NUMERIC = { concepts: 'concepts', finalists: 'finalists', iters: 'maxIters', patience: 'patience', 'round-robin-max': 'roundRobinMax', 'video-attempts': 'videoAttempts', 'motion-test': 'motionTest' } as const

const opts: Record<string, unknown> = { video: false }
const positional: string[] = []
const argv = process.argv.slice(2)

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined]
  if (name === 'video') {
    opts.video = true
    continue
  }
  if (name === 'tournament') {
    const raw = inline ?? argv[++i]
    if (!TOURNAMENT_FORMATS.includes(raw as TournamentFormat)) fail(`--tournament must be one of ${TOURNAMENT_FORMATS.join(', ')}, got ${JSON.stringify(raw)}`)
    opts.tournament = raw
    continue
  }
  if (name in NUMERIC) {
    const raw = inline ?? argv[++i]
    const n = Number(raw)
    if (raw === undefined || !Number.isFinite(n)) fail(`--${name} needs a number, got ${JSON.stringify(raw)}`)
    opts[NUMERIC[name as keyof typeof NUMERIC]] = n
    continue
  }
  fail(`Unknown flag --${name}`)
}

const input = positional[0]
if (!input) fail('No brief given')

let brief = input
try {
  brief = readFileSync(input, 'utf8')
} catch {
  // not a file, treat as the brief itself
}

const options = { ...defaultOptions, ...sanitiseOptions(opts) }
console.log(`mode: ${config.mock ? 'MOCK (no network)' : 'live fal'}, concurrency ${config.concurrency}, ${JSON.stringify(options)}`)

if (options.video && !config.mock && !ffmpegAvailable()) console.log('warning: ffmpeg not found, so the video will be rendered but not checked. Install ffmpeg or set FFMPEG_PATH.')

const run = new Run(brief.trim(), options)
try {
  await runHarness(run, options)
  const f = run.state.final
  console.log(`\nWinner: ${f?.conceptId}\nImage: ${short(f?.image?.url)}${f?.video ? `\nVideo: ${short(f.video.url)}` : ''}\nTrace: ${config.runsDir}/${run.id}.json`)
} catch (err) {
  run.finish('error', String(err))
  console.error(err)
  process.exit(1)
}

function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`)
  process.exit(1)
}

function short(url?: string) {
  if (!url) return '(none)'
  return url.startsWith('data:') ? '(mock placeholder)' : url
}
