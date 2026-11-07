import { createHash } from 'node:crypto'
import { generateJwt } from '@coinbase/cdp-sdk/auth'

export function sandboxReference(userId: string) {
  return `sandbox-agentjob-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`
}

// Sandbox only: never accept a live reference, contact details, amount or destination from the browser.
export function sandboxOrder(userId: string, wallet: string, domain: string) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || /^0x0{40}$/i.test(wallet)) throw new Error('Wallet unavailable')
  return {
    destinationAddress: wallet, destinationNetwork: 'base', purchaseCurrency: 'USDC',
    paymentCurrency: 'USD', paymentAmount: '5.00', paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY',
    partnerUserRef: sandboxReference(userId), domain,
    email: 'agentjob@sandbox.test', phoneNumber: '+12055555555',
    agreementAcceptedAt: new Date().toISOString(), phoneNumberVerifiedAt: new Date().toISOString(),
  }
}

export function sandboxPaymentLink(value: string) {
  const url = new URL(value)
  if (url.origin !== 'https://pay.coinbase.com' || url.username || url.password) throw new Error('Invalid payment link')
  url.searchParams.set('useApplePaySandbox', 'true')
  return url.toString()
}

export function onrampOrigin(request: Request) {
  const configured = process.env.ONRAMP_APP_ORIGIN || 'https://agent-job.ai'
  const origin = new URL(configured).origin
  return request.headers.get('origin') === origin ? origin : null
}

export async function onrampRequest(path: string, body?: unknown) {
  const apiKeyId = process.env.CDP_API_KEY_ID
  const apiKeySecret = process.env.CDP_API_KEY_SECRET
  if (!apiKeyId || !apiKeySecret) throw new Error('Onramp credentials are not configured')
  const token = await generateJwt({ apiKeyId, apiKeySecret, requestHost: 'api.cdp.coinbase.com', requestPath: path, requestMethod: body ? 'POST' : 'GET' })
  const response = await fetch(`https://api.cdp.coinbase.com${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    // Do not expose provider payloads (which may contain contact data or session tokens).
    const error = await response.json().catch(() => null)
    if (error?.errorMessage?.includes('Domain is not allow listed')) {
      throw new Error('Coinbase Onramp returned HTTP 400: add this site to the Onramp domain allowlist in CDP before testing.')
    }
    throw new Error(`Coinbase Onramp returned HTTP ${response.status}. Sandbox access or domain configuration may be required.`)
  }
  return response.json()
}
