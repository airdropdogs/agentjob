import test from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { loginDestination, refreshLoginSession, withLoginTimeout } from './login-session'

test('unresponsive sign-in services time out and late results cannot replace the timeout', async () => {
  let finish!: (value: string) => void
  const operation = new Promise<string>(resolve => { finish = resolve })
  await assert.rejects(withLoginTimeout(operation, 10), /different network/)
  finish('late flow')
  assert.equal(await withLoginTimeout(Promise.resolve('new flow'), 100), 'new flow')
})

test('successful sign-in replaces a fresh anonymous cache before dashboard navigation', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30000 } } })
  client.setQueryData(['session'], null)
  const user = { userId: 'test-user', email: 'test@example.com', role: 'user' }
  await refreshLoginSession(client, async (_url, options) => {
    assert.equal(options?.cache, 'no-store')
    return Response.json({ data: user })
  })
  assert.deepEqual(await client.fetchQuery({ queryKey: ['session'], queryFn: async () => null }), user)
  client.clear()
})

test('missing cookie stays on login rather than navigating into a redirect loop', async () => {
  const client = new QueryClient()
  client.setQueryData(['session'], null)
  await assert.rejects(refreshLoginSession(client, async () => Response.json({ error: 'Unauthorized' }, { status: 401 })), /session could not be saved/)
  assert.equal(client.getQueryData(['session']), null)
  client.clear()
})

test('login return path stays local and cannot point back to login', () => {
  for (const from of [null, '/login', '/login?from=/dashboard', '//other.example', '/\\other.example']) {
    assert.equal(loginDestination(from), '/dashboard')
  }
  assert.equal(loginDestination('/dashboard/agent?tab=settings'), '/dashboard/agent?tab=settings')
})
