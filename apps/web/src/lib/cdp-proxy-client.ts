import { cdpProxyUrl } from './cdp-proxy-path'

// Preserve the SDK's original URL for its auth classification and signature host/path.
// Only the final browser transport is changed. No retries or fallback resends.
export function installCdpProxy(project: string) {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalFetch = window.fetch
  const open: typeof originalOpen = function (this: XMLHttpRequest, ...args: [string, string | URL, boolean?, (string | null)?, (string | null)?]) {
    const proxy = cdpProxyUrl(String(args[1]), args[0], window.location.origin, project)
    if (proxy) args[1] = proxy
    return Reflect.apply(originalOpen, this, args)
  }
  const fetchProxy: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : null
    const proxy = cdpProxyUrl(request ? request.url : String(input), init?.method ?? request?.method ?? 'GET', window.location.origin, project)
    return originalFetch.call(window, proxy ? (request ? new Request(proxy, request) : proxy) : input, init)
  }
  XMLHttpRequest.prototype.open = open
  window.fetch = fetchProxy
  return () => {
    if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = originalOpen
    if (window.fetch === fetchProxy) window.fetch = originalFetch
  }
}
