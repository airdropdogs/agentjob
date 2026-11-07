import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { generateJwt } from '@coinbase/cdp-sdk/auth'

export function hostedSession(userId: string, wallet: string, origin: string, clientIp: string) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || /^0x0{40}$/i.test(wallet)) throw new Error('Wallet unavailable')
  if (!isIP(clientIp)) throw new Error('Client address unavailable')
  return {
    destinationAddress: wallet, destinationNetwork: 'base', purchaseCurrency: 'USDC',
    paymentAmount: '0.0001', paymentCurrency: 'USD', clientIp,
    partnerUserRef: `agentjob-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`,
    redirectUrl: new URL('/dashboard/wallet', origin).toString(),
  }
}

export function hostedCheckoutUrl(value: unknown) {
  if (typeof value !== 'string') throw new Error('Invalid Coinbase checkout')
  const url = new URL(value)
  if (url.origin !== 'https://pay.coinbase.com' || url.username || url.password || !url.searchParams.get('sessionToken') || url.searchParams.has('useApplePaySandbox')) throw new Error('Invalid Coinbase checkout')
  return url.toString()
}

export async function createHostedSession(body: ReturnType<typeof hostedSession>) {
  const apiKeyId = process.env.CDP_API_KEY_ID
  const apiKeySecret = process.env.CDP_API_KEY_SECRET
  if (!apiKeyId || !apiKeySecret) throw new Error('Coinbase checkout is not configured.')
  const path = '/platform/v2/onramp/sessions'
  const token = await generateJwt({ apiKeyId, apiKeySecret, requestHost: 'api.cdp.coinbase.com', requestPath: path, requestMethod: 'POST' })
  const response = await fetch(`https://api.cdp.coinbase.com${path}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  // Do not log provider responses, identity information or session URLs.
  if (!response.ok) throw new Error(`Coinbase checkout returned HTTP ${response.status}. Please check access, availability and trial limits.`)
  return hostedCheckoutUrl((await response.json()).session?.onrampUrl)
}
