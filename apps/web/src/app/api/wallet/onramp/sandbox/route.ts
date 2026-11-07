import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { createLimiter, getRedisOptional } from '@/lib/redis-limiters'
import { onrampOrigin, onrampRequest, sandboxOrder, sandboxPaymentLink, sandboxReference } from '@/lib/onramp-sandbox'
import { sealData, unsealData } from 'iron-session'

function reply(data: unknown, status = 200, origin?: string) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } : {}),
  } })
}

export async function OPTIONS(request: Request) {
  const origin = onrampOrigin(request)
  if (!origin) return reply({ error: 'Origin not allowed' }, 403)
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin',
  } })
}

export async function POST(request: Request) {
  const origin = onrampOrigin(request)
  if (!origin) return reply({ error: 'Origin not allowed' }, 403)
  try {
    const session = await getSession()
    if (!session.userId) return reply({ error: 'Please sign in first' }, 401, origin)
    const user = await getDb().query.users.findFirst({ where: eq(users.id, session.userId), columns: { wallet: true, bannedAt: true } })
    if (!user || user.bannedAt) return reply({ error: 'Account unavailable' }, 403, origin)
    if (!user.wallet) return reply({ error: 'Complete wallet setup first' }, 409, origin)
    const redis = getRedisOptional()
    if (!redis) return reply({ error: 'Sandbox rate limiter unavailable' }, 503, origin)
    if (!(await createLimiter(redis, 'rl:onramp:sandbox', 10, 60000).limit(session.userId)).success) {
      return reply({ error: 'Too many requests. Wait one minute.' }, 429, origin)
    }
    if (Number(request.headers.get('content-length') || 0) > 4096) return reply({ error: 'Request too large' }, 413, origin)
    const body = await request.json().catch(() => null)
    if (!body || !['create', 'status'].includes(body.action)) return reply({ error: 'Invalid action' }, 400, origin)
    if (body.action === 'status') {
      const receipt = typeof body.receipt === 'string' && body.receipt.length < 4096
        ? await unsealData<{ userId: string; wallet: string; orderId: string }>(body.receipt, { password: process.env.SESSION_SECRET!, ttl: 3600 }) : null
      if (!receipt || receipt.userId !== session.userId || receipt.wallet !== user.wallet || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.orderId)) {
        return reply({ error: 'Sandbox session expired. Create a new test.' }, 403, origin)
      }
      const result = await onrampRequest(`/platform/v2/onramp/orders/${receipt.orderId}`)
      const order = result.order ?? result
      if (order.partnerUserRef !== sandboxReference(session.userId) || order.destinationAddress?.toLowerCase() !== user.wallet.toLowerCase()) {
        return reply({ error: 'Order ownership mismatch' }, 502, origin)
      }
      return reply({ sandbox: true, status: order.status, orderId: receipt.orderId }, 200, origin)
    }
    if (body.acceptSandbox !== true) return reply({ error: 'Sandbox acknowledgement required' }, 400, origin)
    // Also prevents duplicate creation across tabs and instances; never auto-retry an ambiguous request.
    if (!await redis.set(`onramp:sandbox:create:${session.userId}`, '1', { nx: true, ex: 60 })) {
      return reply({ error: 'A test was recently created. Wait one minute before starting another.' }, 429, origin)
    }
    const result = await onrampRequest('/platform/v2/onramp/orders', sandboxOrder(session.userId, user.wallet, new URL(origin).hostname))
    if (!result.order?.orderId || !result.paymentLink?.url) return reply({ error: 'Coinbase did not return a sandbox payment link' }, 502, origin)
    const paymentLink = sandboxPaymentLink(result.paymentLink.url)
    const receipt = await sealData({ userId: session.userId, wallet: user.wallet, orderId: result.order.orderId }, { password: process.env.SESSION_SECRET!, ttl: 3600 })
    return reply({ sandbox: true, paymentLink, receipt, orderId: result.order.orderId, wallet: user.wallet,
      paymentTotal: result.order.paymentTotal, purchaseAmount: result.order.purchaseAmount }, 200, origin)
  } catch (error) {
    const message = error instanceof Error && (error.message.startsWith('Coinbase Onramp returned HTTP') || error.message === 'Onramp credentials are not configured')
      ? error.message : 'Sandbox request could not be completed. No live purchase was requested.'
    return reply({ error: message }, 503, origin)
  }
}
