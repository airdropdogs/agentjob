import { randomUUID } from 'node:crypto'
import { allowedCdpPath } from '@/lib/cdp-proxy-path'
import { createLimiter, getRedisOptional } from '@/lib/redis-limiters'
import { rateLimitIdHash } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 30
const COOKIE_PREFIX = 'aj_cdp_'

async function relay(req: Request) {
  const trace = randomUUID()
  const headers = { 'Cache-Control': 'no-store', 'X-CDP-Proxy-Trace': trace }
  const fail = (code: string, status: number) => Response.json({ error: code, trace }, { status, headers })
  if (process.env.CDP_PROXY_TRIAL_ENABLED !== 'true') return fail('CDP_PROXY_DISABLED', 503)
  const url = new URL(req.url)
  const path = url.pathname.slice('/api/cdp'.length)
  const project = process.env.NEXT_PUBLIC_CDP_PROJECT_ID ?? ''
  if (url.search || !allowedCdpPath(path, req.method, project)) return fail('CDP_PROXY_PATH_REJECTED', 404)
  const expectedOrigin = process.env.NODE_ENV === 'production' ? 'https://agent-job.ai' : url.origin
  const origin = req.headers.get('origin')
  if ((req.method !== 'GET' && origin !== expectedOrigin) || (origin && origin !== expectedOrigin) ||
      req.headers.get('sec-fetch-site') === 'cross-site') return fail('CDP_PROXY_ORIGIN_REJECTED', 403)
  const upstreamHeaders = new Headers({ accept: 'application/json', origin: expectedOrigin })
  for (const name of ['authorization', 'x-wallet-auth', 'x-project-id', 'x-idempotency-key', 'content-type']) {
    const value = req.headers.get(name)
    if (value) upstreamHeaders.set(name, value)
  }
  let body: string | undefined
  if (req.method === 'POST' || req.method === 'PUT') {
    const allowEmpty = /\/auth\/(refresh|logout)$/.test(path)
    if (!allowEmpty && !req.headers.get('content-type')?.startsWith('application/json')) return fail('CDP_PROXY_JSON_REQUIRED', 415)
    // Bounded streaming read; Content-Length is not trusted.
    const reader = req.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 128 * 1024) { await reader.cancel(); return fail('CDP_PROXY_BODY_TOO_LARGE', 413) }
      chunks.push(value)
    }
    body = Buffer.concat(chunks).toString('utf8')
    if (allowEmpty && !body) body = undefined
    else {
      if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('CDP_PROXY_JSON_REQUIRED', 415)
      try { JSON.parse(body) } catch { return fail('CDP_PROXY_INVALID_JSON', 400) }
    }
  }
  try {
    const redis = getRedisOptional()
    if (!redis) return fail('CDP_PROXY_LIMITER_UNAVAILABLE', 503)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (!(await createLimiter(redis, 'rl:cdp-proxy', 120, 60000).limit(rateLimitIdHash(ip))).success) return fail('CDP_PROXY_RATE_LIMIT', 429)
    if (path.endsWith('/auth/init')) {
      const email = JSON.parse(body ?? '{}').email
      if (typeof email !== 'string' || email.length > 320) return fail('CDP_PROXY_EMAIL_REQUIRED', 400)
      for (const [prefix, key] of [['ip', ip], ['email', email]]) {
        if (!(await createLimiter(redis, 'rl:cdp-proxy-init:' + prefix, 5, 600000).limit(rateLimitIdHash(key))).success) return fail('CDP_PROXY_RATE_LIMIT', 429)
      }
    }
  } catch { return fail('CDP_PROXY_LIMITER_UNAVAILABLE', 503) }
  // Forward only this relay's namespaced cookies, never the site's session cookie.
  const cookies: string[] = []
  for (const cookie of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = cookie.trim().split('=')
    if (!name.startsWith(COOKIE_PREFIX)) continue
    const decoded = Buffer.from(name.slice(COOKIE_PREFIX.length), 'hex').toString('utf8')
    if (/^[a-zA-Z0-9_-]+$/.test(decoded)) cookies.push(decoded + '=' + value.join('='))
  }
  if (cookies.length) upstreamHeaders.set('cookie', cookies.join('; '))
  try {
    const response = await fetch('https://api.cdp.coinbase.com' + path, {
      method: req.method, headers: upstreamHeaders, body, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
    })
    if (response.status >= 300 && response.status < 400) return fail('CDP_PROXY_REDIRECT_REJECTED', 502)
    const resultHeaders = new Headers(headers)
    resultHeaders.set('Content-Type', response.headers.get('content-type') ?? 'application/json')
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';')
      const equal = pair.indexOf('=')
      const name = pair.slice(0, equal).trim()
      if (equal < 1 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue
      const expiry = attributes.filter(a => /^\s*(max-age|expires)=/i.test(a)).join(';')
      resultHeaders.append('Set-Cookie', `${COOKIE_PREFIX}${Buffer.from(name).toString('hex')}=${pair.slice(equal + 1)}; Path=/api/cdp; HttpOnly; Secure; SameSite=Strict${expiry ? ';' + expiry : ''}`)
    }
    const content = await response.arrayBuffer()
    return new Response(response.status === 204 ? null : content, { status: response.status, headers: resultHeaders })
  } catch (error) {
    return fail(error instanceof Error && error.name === 'TimeoutError' ? 'CDP_PROXY_UPSTREAM_TIMEOUT' : 'CDP_PROXY_UPSTREAM_UNAVAILABLE', 502)
  }
}

export const GET = relay
export const POST = relay
export const PUT = relay
