import { readdirSync, readFileSync } from 'node:fs'
import { config, defaultOptions, sanitiseOptions } from './config.ts'
import { startRun } from './harness/loop.ts'
import { getRun, listRuns, reconcileOrphanedRuns } from './trace.ts'
import { ffmpegAvailable } from './video/clip.ts'

// Minimal API + static UI. The UI polls /api/runs/:id, which is the whole trace.
// For the live demo use `bun run start` (no --watch): a file save would restart the
// server and cut off any run in progress.

const json = (data: unknown, status = 200) => Response.json(data, { status })

const orphaned = reconcileOrphanedRuns()
if (orphaned) console.log(`marked ${orphaned} interrupted run(s) as error`)

const server = Bun.serve({
  port: config.port,
  routes: {
    // Served per request so UI edits show on refresh without a restart.
    '/': () => new Response(Bun.file('public/index.html')),
    '/api/health': () => json({ mock: config.mock, concurrency: config.concurrency, defaults: defaultOptions, ffmpeg: ffmpegAvailable() }),
    '/api/briefs': () => {
      const files = safeList('briefs').filter((f) => f.endsWith('.md'))
      return json(files.map((f) => ({ name: f, text: readFileSync(`briefs/${f}`, 'utf8') })))
    },
    '/api/runs': {
      GET: () => json(listRuns()),
      POST: async (req) => {
        const body: unknown = await req.json().catch(() => null)
        const { brief, options } = (body && typeof body === 'object' ? body : {}) as { brief?: unknown; options?: unknown }
        if (typeof brief !== 'string' || !brief.trim()) return json({ error: 'brief is required' }, 400)
        if (brief.length > 8000) return json({ error: 'brief is too long (8000 chars max)' }, 400)
        const opts = options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
        const run = startRun(brief.trim(), sanitiseOptions(opts))
        return json({ id: run.id }, 201)
      },
    },
    '/api/runs/:id': (req) => {
      const run = getRun(req.params.id)
      return run ? json(run) : json({ error: 'not found' }, 404)
    },
  },
  fetch: () => json({ error: 'not found' }, 404),
  error: (err) => json({ error: err.message }, 500),
})

console.log(`creative-harness on http://localhost:${server.port} (${config.mock ? 'MOCK mode' : 'live fal'}, concurrency ${config.concurrency})`)

function safeList(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
