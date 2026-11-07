const ROOT = '/platform/v2/embedded-wallet-api/projects/'

export function allowedCdpPath(path: string, method: string, project: string): boolean {
  if (!project || !path.startsWith(ROOT + project + '/')) return false
  const tail = path.slice((ROOT + project + '/').length)
  if (method === 'GET') return /^(config|auth\/mfa|end-users\/[a-zA-Z0-9-]+)$/.test(tail)
  if (method !== 'POST') return false
  return /^(auth\/(init|verify\/email|refresh|logout)|end-users\/[a-zA-Z0-9-]+\/(wallet-secrets|evm|evm\/smart-accounts|evm\/sign\/(message|typed-data)))$/.test(tail)
}

export function cdpProxyUrl(input: string, method: string, origin: string, project: string): string | null {
  try {
    const url = new URL(input)
    if (url.origin !== 'https://api.cdp.coinbase.com' || url.username || url.password || url.search || url.hash ||
      !allowedCdpPath(url.pathname, method.toUpperCase(), project)) return null
    return origin + '/api/cdp' + url.pathname
  } catch { return null }
}
