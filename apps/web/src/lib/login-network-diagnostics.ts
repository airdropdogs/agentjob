import type { LoginStage } from './login-diagnostics'

export type LoginRequest = {
  id: number; stage: LoginStage | null; endpoint: string; at: string; started: number;
  elapsedMs: number; code: string; httpStatus?: number; transport?: 'fetch' | 'xhr'; proxyTrace?: string
}

// Never retain query strings, fragments, credentials or dynamic path identifiers.
export function diagnosticEndpoint(input: string, origin: string): string | null {
  try {
    const url = new URL(input, origin)
    if (!(url.hostname === 'coinbase.com' || url.hostname.endsWith('.coinbase.com') ||
      (url.origin === origin && (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/cdp/'))))) return null
    const safeSegments = new Set(['platform', 'v1', 'v2', 'api', 'cdp', 'auth', 'cdp-sync', 'session',
      'embedded-wallet', 'embedded-wallets', 'embedded-wallet-api', 'init', 'mfa', 'wallets', 'users', 'projects', 'config', 'configuration',
      'email', 'otp', 'send', 'verify', 'login', 'logout', 'refresh', 'token', 'tokens',
      'authenticate', 'authentication', 'accounts', 'smart-accounts', 'amp'])
    return url.origin + url.pathname.split('/').map(segment => !segment || safeSegments.has(segment) ? segment : '[redacted]').join('/')
  } catch { return null }
}

export function observeLoginFetch(
  target: { fetch: typeof fetch }, origin: string,
  stage: () => LoginStage | null, record: (event: LoginRequest) => void,
) {
  const original = target.fetch
  let active = true
  let nextId = 0
  const wrapped: typeof fetch = async (input, init) => {
    const endpoint = diagnosticEndpoint(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin)
    if (!endpoint) return original.call(target, input, init)
    const started = Date.now()
    const event: LoginRequest = { id: ++nextId, stage: stage(), endpoint, started,
      at: new Date(started).toISOString(), elapsedMs: 0, code: 'LOGIN_REQUEST_PENDING', transport: 'fetch' }
    if (active) record(event)
    try {
      const response = await original.call(target, input, init)
      const trace = response.headers.get('x-cdp-proxy-trace')
      if (active) record({ ...event, ...(trace && /^[a-f0-9-]{36}$/.test(trace) ? { proxyTrace: trace } : {}), elapsedMs: Date.now() - started,
        code: response.ok ? 'LOGIN_REQUEST_OK' : 'LOGIN_REQUEST_HTTP', httpStatus: response.status })
      return response
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (active) record({ ...event, elapsedMs: Date.now() - started,
        code: name === 'AbortError' || name === 'TimeoutError' ? 'LOGIN_REQUEST_ABORTED' : 'LOGIN_REQUEST_NETWORK' })
      throw error
    }
  }
  target.fetch = wrapped
  return () => {
    active = false
    if (target.fetch === wrapped) target.fetch = original
  }
}

export function observeLoginXhr(
  constructor: typeof XMLHttpRequest, origin: string,
  stage: () => LoginStage | null, record: (event: LoginRequest) => void,
) {
  const prototype = constructor.prototype
  const originalOpen = prototype.open
  const originalSend = prototype.send
  const endpoints = new WeakMap<XMLHttpRequest, string>()
  const cleanups = new Set<() => void>()
  let nextId = 0
  let active = true
  const open: typeof prototype.open = function (this: XMLHttpRequest, ...args: [string, string | URL, boolean?, (string | null)?, (string | null)?]) {
    const endpoint = diagnosticEndpoint(String(args[1]), origin)
    endpoints.delete(this)
    if (endpoint) endpoints.set(this, endpoint)
    return Reflect.apply(originalOpen, this, args)
  }
  const send: typeof prototype.send = function (this: XMLHttpRequest, ...args) {
    const endpoint = endpoints.get(this)
    if (!endpoint) return Reflect.apply(originalSend, this, args)
    const started = Date.now()
    const event: LoginRequest = { id: --nextId, stage: stage(), endpoint, started,
      at: new Date(started).toISOString(), elapsedMs: 0, code: 'LOGIN_REQUEST_PENDING', transport: 'xhr' }
    if (active) record(event)
    const cleanup = () => {
      for (const type of ['load', 'error', 'timeout', 'abort']) this.removeEventListener(type, finish)
      cleanups.delete(cleanup)
    }
    const finish = (result: Event) => {
      cleanup()
      if (!active) return
      const status = this.status
      const trace = this.getResponseHeader('x-cdp-proxy-trace')
      record({ ...event, elapsedMs: Date.now() - started,
        ...(trace && /^[a-f0-9-]{36}$/.test(trace) ? { proxyTrace: trace } : {}),
        ...(status > 0 ? { httpStatus: status } : {}),
        code: result.type === 'abort' ? 'LOGIN_REQUEST_ABORTED' : result.type === 'timeout' ? 'LOGIN_REQUEST_TIMEOUT' :
          result.type === 'error' || status === 0 ? 'LOGIN_REQUEST_NETWORK' :
          status >= 200 && status < 300 ? 'LOGIN_REQUEST_OK' : 'LOGIN_REQUEST_HTTP' })
    }
    cleanups.add(cleanup)
    for (const type of ['load', 'error', 'timeout', 'abort']) this.addEventListener(type, finish)
    try { return Reflect.apply(originalSend, this, args) }
    catch (error) { finish(new Event('error')); throw error }
  }
  prototype.open = open
  prototype.send = send
  return () => {
    active = false
    for (const cleanup of cleanups) cleanup()
    if (prototype.open === open) prototype.open = originalOpen
    if (prototype.send === send) prototype.send = originalSend
  }
}
