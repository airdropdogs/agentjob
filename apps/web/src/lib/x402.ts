/**
 * x402 payment verify + settle (CDP facilitator).
 *
 * Flow: 402 + accepts[] → client signs EIP-3009 → X-PAYMENT header → verify + settle on CDP.
 * Gas via Coinbase Paymaster (no server ETH).
 *
 * Env: CDP_API_KEY_ID, CDP_API_KEY_SECRET
 */

import { createAuthHeader, createCorrelationHeader } from '@coinbase/x402'
import { decodeXPaymentResponse } from 'x402-fetch'

/** x402 v1 PaymentRequirements (matches 402 accepts[] entry). */
export interface PaymentRequirements {
  scheme: 'exact'
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra?: Record<string, unknown>
}

export interface X402PaymentResult {
  success: boolean
  agentTx?: string
  failedOn?: 'verify' | 'settle'
  error?: string
  /** If optimistic, settle may still be in progress */
  optimistic?: boolean
}

export interface X402PaymentRequest {
  paymentHeader: string
  agentWallet: string
  amountUsdc: number
  platformFeeRate: number
  paymentRequirements: PaymentRequirements
}

/**
 * Internal: prepare CDP auth and body for verify/settle.
 */
async function prepareX402(req: X402PaymentRequest) {
  const { paymentHeader, paymentRequirements } = req
  const paymentPayload = decodeXPaymentResponse(paymentHeader)

  const CDP_HOST = 'api.cdp.coinbase.com'
  const CDP_ROUTE = '/platform/v2/x402'
  const apiKeyId = process.env.CDP_API_KEY_ID!
  const apiKeySecret = process.env.CDP_API_KEY_SECRET!
  const correlationHeader = createCorrelationHeader()

  const [verifyAuth, settleAuth] = await Promise.all([
    createAuthHeader(apiKeyId, apiKeySecret, 'POST', CDP_HOST, `${CDP_ROUTE}/verify`),
    createAuthHeader(apiKeyId, apiKeySecret, 'POST', CDP_HOST, `${CDP_ROUTE}/settle`),
  ])

  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements })
  const CDP_BASE = `https://${CDP_HOST}${CDP_ROUTE}`

  return { CDP_BASE, body, verifyAuth, settleAuth, correlationHeader }
}

/** Verify x402 payment (fast, no on-chain tx). */
async function verifyX402(
  CDP_BASE: string, body: string,
  verifyAuth: string, correlationHeader: string,
): Promise<{ valid: boolean; error?: string; payer?: string }> {
  const verifyResp = await fetch(`${CDP_BASE}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': verifyAuth,
      'Correlation-Context': correlationHeader,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!verifyResp.ok) {
    const text = await verifyResp.text()
    console.error('[x402] verify failed:', verifyResp.status, text)
    return { valid: false, error: `verify failed (${verifyResp.status}): ${text}` }
  }

  const verifyData = await verifyResp.json() as { isValid: boolean; invalidReason?: string; payer?: string }
  console.log('[x402] verify result:', JSON.stringify(verifyData))
  if (verifyData.isValid !== true) {
    return { valid: false, error: verifyData.invalidReason ?? 'invalid payment' }
  }
  return { valid: true, payer: verifyData.payer }
}

/** Settle x402 payment (on-chain, slow). */
async function settleX402(
  CDP_BASE: string, body: string,
  settleAuth: string, correlationHeader: string,
): Promise<{ success: boolean; transaction?: string; error?: string }> {
  const settleResp = await fetch(`${CDP_BASE}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': settleAuth,
      'Correlation-Context': correlationHeader,
    },
    body,
    signal: AbortSignal.timeout(45_000),
  })

  if (!settleResp.ok) {
    const text = await settleResp.text()
    return { success: false, error: `settle failed (${settleResp.status}): ${text}` }
  }

  const settleData = await settleResp.json() as { success: boolean; transaction?: string; errorReason?: string }
  if (settleData.success !== true) {
    return { success: false, error: settleData.errorReason ?? 'settle failed' }
  }
  return { success: true, transaction: settleData.transaction }
}

/** Verify then settle x402 payment via CDP (synchronous, original behavior). */
export async function executeX402Payment(
  req: X402PaymentRequest
): Promise<X402PaymentResult> {
  try {
    const { CDP_BASE, body, verifyAuth, settleAuth, correlationHeader } = await prepareX402(req)

    const verify = await verifyX402(CDP_BASE, body, verifyAuth, correlationHeader)
    if (!verify.valid) {
      return { success: false, failedOn: 'verify', error: verify.error }
    }

    const settle = await settleX402(CDP_BASE, body, settleAuth, correlationHeader)
    if (!settle.success) {
      return { success: false, failedOn: 'settle', error: settle.error }
    }

    return { success: true, agentTx: settle.transaction }
  } catch (err) {
    return { success: false, failedOn: 'settle', error: String(err) }
  }
}

/**
 * x402 Optimistic Execution: verify synchronously, settle asynchronously.
 * Returns immediately after verify succeeds. Settle runs in the background.
 * Saves 2-5s per payment.
 */
export async function executeX402Optimistic(
  req: X402PaymentRequest
): Promise<X402PaymentResult> {
  try {
    const { CDP_BASE, body, verifyAuth, settleAuth, correlationHeader } = await prepareX402(req)

    // Synchronous verify (fast, ~200ms)
    const verify = await verifyX402(CDP_BASE, body, verifyAuth, correlationHeader)
    if (!verify.valid) {
      return { success: false, failedOn: 'verify', error: verify.error }
    }

    // Asynchronous settle (slow, 2-5s on-chain — fire and forget)
    settleX402(CDP_BASE, body, settleAuth, correlationHeader)
      .then(result => {
        if (!result.success) {
          console.error('[x402-optimistic] settle failed (async):', result.error)
          // TODO: mark payment as failed in DB, notify user
        } else {
          console.log('[x402-optimistic] settle OK tx=', result.transaction)
        }
      })
      .catch(err => {
        console.error('[x402-optimistic] settle error (async):', err)
      })

    return { success: true, optimistic: true }
  } catch (err) {
    return { success: false, failedOn: 'verify', error: String(err) }
  }
}

export function extractPaymentHeader(req: Request): string | null {
  return req.headers.get('x-payment')
}

/** Acceptance uses separate verify/settle steps so the durable ledger owns the state transition. */
export async function verifyAcceptancePayment(req: X402PaymentRequest, payer: string): Promise<boolean> {
  const decoded = decodeXPaymentResponse(req.paymentHeader) as unknown as {
    x402Version?: number; scheme?: string; network?: string
    payload?: { authorization?: { from?: string; to?: string; value?: string } }
  }
  const auth = decoded.payload?.authorization
  if (decoded.x402Version !== 1 || decoded.scheme !== 'exact' || decoded.network !== 'base' ||
      auth?.from?.toLowerCase() !== payer.toLowerCase() ||
      auth?.to?.toLowerCase() !== req.paymentRequirements.payTo.toLowerCase() ||
      auth?.value !== req.paymentRequirements.maxAmountRequired) return false
  const prepared = await prepareX402(req)
  const result = await verifyX402(prepared.CDP_BASE, prepared.body, prepared.verifyAuth, prepared.correlationHeader)
  return result.valid && result.payer?.toLowerCase() === payer.toLowerCase()
}

export async function settleAcceptancePayment(req: X402PaymentRequest): Promise<{ transaction: string }> {
  const prepared = await prepareX402(req)
  const result = await settleX402(prepared.CDP_BASE, prepared.body, prepared.settleAuth, prepared.correlationHeader)
  if (!result.success || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction ?? '')) {
    throw new Error('Payment settlement requires reconciliation')
  }
  return { transaction: result.transaction! }
}
