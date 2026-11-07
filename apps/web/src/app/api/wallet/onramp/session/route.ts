import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { createLimiter, getRedisOptional } from '@/lib/redis-limiters'
import { onrampOrigin } from '@/lib/onramp-sandbox'
import { createHostedSession, hostedSession } from '@/lib/onramp-hosted'

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } })
}

export async function POST(request: Request) {
  const origin = onrampOrigin(request)
  if (!origin) return reply({ error: 'Origin not allowed' }, 403)
  try {
    const session = await getSession()
    if (!session.userId) return reply({ error: 'Please sign in first.' }, 401)
    const user = await getDb().query.users.findFirst({ where: eq(users.id, session.userId), columns: { wallet: true, bannedAt: true } })
    if (!user || user.bannedAt) return reply({ error: 'Account unavailable.' }, 403)
    if (!user.wallet) return reply({ error: 'Complete wallet setup first.' }, 409)
    if (Number(request.headers.get('content-length') || 0) > 1024) return reply({ error: 'Request too large.' }, 413)
    const body = await request.json().catch(() => null)
    if (body?.acceptLive !== true) return reply({ error: 'Please acknowledge that this is a real purchase.' }, 400)
    // Use the last address appended by the deployment proxy, not a client-supplied first entry.
    const clientIp = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || ''
    const params = hostedSession(session.userId, user.wallet, origin, clientIp)
    const redis = getRedisOptional()
    if (!redis) return reply({ error: 'Checkout is temporarily unavailable.' }, 503)
    if (!(await createLimiter(redis, 'rl:onramp:hosted', 5, 60000).limit(session.userId)).success ||
        !await redis.set(`onramp:hosted:create:${session.userId}`, '1', { nx: true, ex: 60 })) {
      return reply({ error: 'A checkout was recently requested. Wait one minute before creating another.' }, 429)
    }
    const url = await createHostedSession(params)
    return reply({ url, live: true, paymentAmount: '5.00', paymentCurrency: 'USD' })
  } catch (error) {
    const message = error instanceof Error && (error.message.startsWith('Coinbase checkout') || error.message === 'Client address unavailable')
      ? error.message : 'Unable to create checkout. Wait one minute before trying again.'
    return reply({ error: message }, 503)
  }
}
