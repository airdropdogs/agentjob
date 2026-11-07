import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorker, jobs } from './railway-worker.mjs'

test('worker runs all jobs after startup and restart, authenticates POST without redirects', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const controller = new AbortController()
    const calls = []
    await runWorker({ baseUrl: 'http://web.railway.internal:3000', secret: 'test-secret', signal: controller.signal,
      log: { info() {}, error() {} },
      fetcher: async (url, options) => {
        calls.push(url.pathname)
        assert.equal(options.method, 'POST')
        assert.equal(options.headers['x-internal-secret'], 'test-secret')
        assert.equal(options.redirect, 'error')
        if (calls.length === jobs.length) controller.abort()
        return new Response('{}')
      },
    })
    assert.deepEqual(calls, jobs.map((job) => `/api/internal/${job.path}`))
  }
})

test('one unavailable endpoint does not block other maintenance jobs', async () => {
  const controller = new AbortController()
  const calls = []
  const errors = []
  await runWorker({ baseUrl: 'http://localhost:3000', secret: 'test-secret', signal: controller.signal,
    log: { info() {}, error(message) { errors.push(message) } },
    fetcher: async (url) => {
      calls.push(url.pathname)
      if (calls.length === 1) return new Response('{}', { status: 503 })
      if (calls.length === jobs.length) controller.abort()
      return new Response('{}')
    },
  })
  assert.equal(calls.length, jobs.length)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /HTTP 503/)
  assert.ok(!errors[0].includes('test-secret'))
})
