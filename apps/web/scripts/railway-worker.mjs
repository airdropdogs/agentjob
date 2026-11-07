import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const jobs = [
  { path: 'verify-agents', interval: 15_000 },
  { path: 'timeout-tasks', interval: 60_000 },
  { path: 'unlock-expired', interval: 600_000 },
  { path: 'cleanup-attachments', interval: 600_000 },
]

// Run all maintenance on startup so redeploys do not lose a scheduled cleanup.
// The endpoints use conditional database updates, making retries safe.
export async function runWorker({ baseUrl, secret, signal, fetcher = fetch, log = console }) {
  if (!baseUrl || !secret) throw new Error('WORKER_API_URL and INTERNAL_API_SECRET are required')
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('WORKER_API_URL must be an HTTP(S) origin without credentials')
  }
  const next = new Map()
  while (!signal.aborted) {
    for (const job of jobs) {
      if (signal.aborted) break
      if ((next.get(job.path) ?? 0) > Date.now()) continue
      try {
        const response = await fetcher(new URL(`/api/internal/${job.path}`, url), {
          method: 'POST',
          headers: { 'x-internal-secret': secret },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(55_000)]),
        })
        // Consume the body to release the underlying connection; never log secrets.
        await response.arrayBuffer()
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        next.set(job.path, Date.now() + job.interval)
        log.info(`[worker] ${job.path} completed`)
      } catch (error) {
        if (signal.aborted) break
        next.set(job.path, Date.now() + 15_000)
        log.error(`[worker] ${job.path} failed: ${error instanceof Error ? error.message : 'request failed'}`)
      }
    }
    await sleep(1_000, undefined, { signal }).catch((error) => {
      if (!signal.aborted) throw error
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  runWorker({ baseUrl: process.env.WORKER_API_URL, secret: process.env.INTERNAL_API_SECRET, signal: controller.signal })
    .catch((error) => { console.error(`[worker] ${error.message}`); process.exitCode = 1 })
}
