import { CHAT_MESSAGE_HARD_MAX_MICRO, CHAT_AUTHORIZATION_HARD_MAX_MICRO } from './chat-payment-policy'
export const CHAT_PAYMENT_MAX_MICRO = BigInt(CHAT_MESSAGE_HARD_MAX_MICRO)
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export type PaymentPhase = 'platform_fee' | 'agent'
export type PaymentQuote = { amount: string; payTo: string; network: string; asset: string }
export type ChatEligibility = {
  freeMessagesRemaining?: number; freeMessagesPerUser?: number
  eligible: boolean | null; reason: string; payer: string | null; priceMicro: string | number; platformFeeMicro: string | number; agentMicro: string | number
  platformRecipient: string; agentRecipient: string; remainingBudgetMicro: string | number; paymentEnabled: boolean
  maxMessageMicro?: number; authorizationMinutes?: number
}
export type PaymentScope = { agentId: string; payer: string; priceMicro: string; platformFeeMicro: string; agentMicro: string; platformRecipient: string; agentRecipient: string }
export type PaymentGrant = { scope: PaymentScope; expiresAt: number; budgetMicro: string; reserved: Record<string, string> }

export function paymentScope(agentId: string, payer: string, eligibility: ChatEligibility): PaymentScope {
  if (!payer || !eligibility.payer || payer.toLowerCase() !== eligibility.payer.toLowerCase()) throw new Error('Payment wallet does not match your signed-in account')
  const fields = [eligibility.priceMicro, eligibility.platformFeeMicro, eligibility.agentMicro, eligibility.remainingBudgetMicro]
  if (!fields.every(value => /^\d+$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value))) || BigInt(eligibility.priceMicro) <= BigInt(0) ||
      BigInt(eligibility.priceMicro) > CHAT_PAYMENT_MAX_MICRO ||
      (eligibility.maxMessageMicro !== undefined && (!Number.isSafeInteger(eligibility.maxMessageMicro) || Number(eligibility.priceMicro) > eligibility.maxMessageMicro)) ||
      BigInt(eligibility.platformFeeMicro) + BigInt(eligibility.agentMicro) !== BigInt(eligibility.priceMicro) ||
      ![payer, eligibility.platformRecipient, eligibility.agentRecipient].every(value => /^0x[0-9a-f]{40}$/i.test(value))) throw new Error('Invalid payment authorization details')
  return { agentId, payer: payer.toLowerCase(), priceMicro: String(eligibility.priceMicro),
    platformFeeMicro: String(eligibility.platformFeeMicro), agentMicro: String(eligibility.agentMicro),
    platformRecipient: eligibility.platformRecipient.toLowerCase(), agentRecipient: eligibility.agentRecipient.toLowerCase() }
}

export function grantMatches(grant: PaymentGrant | null, scope: PaymentScope, now = Date.now()): grant is PaymentGrant {
  return !!grant && grant.expiresAt > now && JSON.stringify(grant.scope) === JSON.stringify(scope)
}

export function createPaymentGrant(scope: PaymentScope, remainingBudgetMicro: string, now = Date.now(), chosenBudgetMicro = remainingBudgetMicro, minutes = 60): PaymentGrant {
  if (![remainingBudgetMicro, chosenBudgetMicro].every(value => /^\d+$/.test(value))) throw new Error('Invalid payment budget')
  const maximum = BigInt(remainingBudgetMicro), budget = BigInt(chosenBudgetMicro)
  if (budget < BigInt(scope.priceMicro) || budget > maximum || maximum > BigInt(CHAT_AUTHORIZATION_HARD_MAX_MICRO) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Invalid payment budget or expiry')
  return { scope, expiresAt: now + minutes * 60_000, budgetMicro: String(budget), reserved: {} }
}

export function reserveMessage(grant: PaymentGrant, key: string, remainingBudgetMicro: string, now = Date.now()): void {
  if (grant.expiresAt <= now) throw new Error('Payment authorization expired')
  if (grant.reserved[key]) return
  const price = BigInt(grant.scope.priceMicro)
  const reserved = Object.values(grant.reserved).reduce((sum, amount) => sum + BigInt(amount), BigInt(0))
  if (reserved + price > BigInt(grant.budgetMicro) || price > BigInt(remainingBudgetMicro)) throw new Error('Payment authorization budget exhausted')
  grant.reserved[key] = String(price)
}

export function quoteMatchesScope(phase: PaymentPhase, quote: PaymentQuote, scope: PaymentScope): boolean {
  return quote.amount === (phase === 'platform_fee' ? scope.platformFeeMicro : scope.agentMicro) &&
    quote.payTo.toLowerCase() === (phase === 'platform_fee' ? scope.platformRecipient : scope.agentRecipient)
}

export async function readPaymentQuote(response: Response): Promise<PaymentQuote> {
  const body = await response.clone().json()
  const accepts = body.accepts
  if (!Array.isArray(accepts) || accepts.length !== 1) throw new Error('Unsupported payment requirements')
  const requirement = accepts[0]
  const amount = requirement.maxAmountRequired ?? requirement.amount
  if (requirement.scheme !== 'exact' || !['base', 'eip155:8453'].includes(requirement.network) ||
      String(requirement.asset).toLowerCase() !== BASE_USDC ||
      !/^0x[0-9a-f]{40}$/i.test(requirement.payTo ?? '') ||
      typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= BigInt(0) || BigInt(amount) > CHAT_PAYMENT_MAX_MICRO) {
    throw new Error('Payment must be Base USDC within the supported message limit')
  }
  return { amount, payTo: requirement.payTo, network: requirement.network, asset: requirement.asset }
}

export function samePaymentQuote(left: PaymentQuote, right: PaymentQuote): boolean {
  return left.amount === right.amount && left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    left.network === right.network && left.asset.toLowerCase() === right.asset.toLowerCase()
}

export async function submitChatPayment(options: {
  quotes: Partial<Record<PaymentPhase, PaymentQuote>>
  request: (phase: PaymentPhase) => Promise<Response>
  confirm: (phase: PaymentPhase, quote: PaymentQuote) => Promise<boolean>
  pay: (phase: PaymentPhase, quote: PaymentQuote) => Promise<Response>
}): Promise<Response> {
  for (const phase of ['platform_fee', 'agent'] as const) {
    let response = await options.request(phase)
    if (response.status === 402) {
      const quote = await readPaymentQuote(response)
      options.quotes[phase] = quote
      const total = Object.values(options.quotes).reduce((sum, entry) => sum + BigInt(entry.amount), BigInt(0))
      if (total > CHAT_PAYMENT_MAX_MICRO) throw new Error('Total payment exceeds the supported message limit')
      if (!(await options.confirm(phase, quote))) throw new Error('Payment cancelled. Retry this message when ready.')
      response = await options.pay(phase, quote)
    }
    // Free requests and replayed completed intents already have a task. Never pay again.
    if (response.status === 202 || !response.ok || phase === 'agent') return response
  }
  throw new Error('Chat request did not return a task')
}
