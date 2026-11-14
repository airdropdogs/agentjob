export const CHAT_MESSAGE_HARD_MAX_MICRO = 100_000_000
export const CHAT_AUTHORIZATION_HARD_MAX_MICRO = 1_000_000_000
export const DEFAULT_CHAT_PAYMENT_POLICY = {
  chatPaymentsEnabled: true,
  chatMaxMessageUsdc: 100,
  chatMaxAuthorizationUsdc: 100,
  chatAuthorizationMinutes: 60,
}
export type ChatPaymentPolicy = typeof DEFAULT_CHAT_PAYMENT_POLICY
export const CHAT_PAYMENT_CONFIG_KEYS = ['chat_payments_enabled', 'chat_max_message_usdc', 'chat_max_authorization_usdc', 'chat_authorization_minutes']

export function usdcMicro(value: string): number | null {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const micro = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  return Number.isSafeInteger(micro) ? micro : null
}

export function validChatPaymentSetting(key: string, value: string): boolean {
  if (!CHAT_PAYMENT_CONFIG_KEYS.includes(key)) return true
  if (key === 'chat_payments_enabled') return value === 'true' || value === 'false'
  if (key === 'chat_authorization_minutes') return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1440
  const micro = usdcMicro(value)
  return micro !== null && micro > 0 && micro <= (key === 'chat_max_message_usdc' ? CHAT_MESSAGE_HARD_MAX_MICRO : CHAT_AUTHORIZATION_HARD_MAX_MICRO)
}

export function validChatPaymentPolicy(policy: ChatPaymentPolicy): boolean {
  return typeof policy.chatPaymentsEnabled === 'boolean' &&
    validChatPaymentSetting('chat_max_message_usdc', String(policy.chatMaxMessageUsdc)) &&
    validChatPaymentSetting('chat_max_authorization_usdc', String(policy.chatMaxAuthorizationUsdc)) &&
    validChatPaymentSetting('chat_authorization_minutes', String(policy.chatAuthorizationMinutes)) &&
    policy.chatMaxAuthorizationUsdc >= policy.chatMaxMessageUsdc
}
