import { NextRequest, NextResponse } from 'next/server'
import { redisLimiters } from '@/lib/redis-limiters'

const SESSION_COOKIE = 'agentjob_session_v2'

// Route protection
const AUTH_REQUIRED_PREFIXES = ['/dashboard', '/admin']

// In-memory rate limits (fallback when Redis is not configured).
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function memRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (entry.count >= limit) {
    return false
  }

  entry.count++
  return true
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'

  const rl = redisLimiters

  // 1. Auth-gated routes
  if (AUTH_REQUIRED_PREFIXES.some((p) => pathname.startsWith(p))) {
    const sessionCookie = req.cookies.get(SESSION_COOKIE)
    if (!sessionCookie?.value) {
      const loginUrl = new URL('/login', req.url)
      loginUrl.searchParams.set('from', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }

  // 2. send-otp: 5 req / 10 min per IP
  if (pathname === '/api/auth/send-otp' && req.method === 'POST') {
    const allowed = rl
      ? (await rl.otpIpLimit.limit(`ip:${ip}`)).success
      : memRateLimit(`otp:${ip}`, 5, 10 * 60 * 1000)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait before requesting another OTP.' },
        {
          status: 429,
          headers: { 'Retry-After': '600' },
        },
      )
    }
  }

  // 3. cdp-sync: 10 req / 10 min per IP
  if (pathname === '/api/auth/cdp-sync' && req.method === 'POST') {
    let allowed: boolean
    try {
      allowed = rl
        ? (await rl.cdpSyncIpLimit.limit(`ip:${ip}`)).success
        : memRateLimit(`cdp-sync:${ip}`, 10, 10 * 60 * 1000)
    } catch {
      console.warn('[middleware] Login rate-limit backend unavailable; using per-instance limit')
      allowed = memRateLimit(`cdp-sync:${ip}`, 10, 10 * 60 * 1000)
    }
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests.' },
        { status: 429, headers: { 'Retry-After': '600' } },
      )
    }
  }

  // 4. chat: 60 req / min per IP
  if (pathname === '/api/chat' && req.method === 'POST') {
    const allowed = rl
      ? (await rl.chatIpLimit.limit(`ip:${ip}`)).success
      : memRateLimit(`chat:${ip}`, 60, 60 * 1000)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please slow down.' },
        { status: 429, headers: { 'Retry-After': '60' } },
      )
    }
  }

  // 5. /api/mcp — precise API key limit lives in route handler (Redis). No duplicate limit here.

  // 6. POST /api/agents: 10 agent creations / hour per IP
  if (pathname === '/api/agents' && req.method === 'POST') {
    const allowed = rl
      ? (await rl.agentsPostIpLimit.limit(`ip:${ip}`)).success
      : memRateLimit(`agent-reg:${ip}`, 10, 60 * 60 * 1000)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many agent registrations from this IP. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '3600' } },
      )
    }
  }

  return NextResponse.next()
}

export const config = {
  runtime: 'nodejs',
  matcher: [
    '/dashboard/:path*',
    '/admin/:path*',
    '/api/auth/send-otp',
    '/api/auth/cdp-sync',
    '/api/chat',
    '/api/agents',
  ],
}
