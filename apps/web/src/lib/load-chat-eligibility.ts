import type { ChatEligibility } from './chat-payment'

export async function loadChatEligibility(params: URLSearchParams, fetcher: typeof fetch = fetch): Promise<ChatEligibility> {
  const response = await fetcher('/api/chat/eligibility?' + params, {
    cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`PRICE_CHECK_HTTP_${response.status}`)
  const result = await response.json()
  if (typeof result?.eligible !== 'boolean') throw new Error('PRICE_CHECK_UNAVAILABLE')
  return result
}
