import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getPlatformConfig, updateConfigValues } from '@/lib/platform-config'
import { CHAT_PAYMENT_CONFIG_KEYS, validChatPaymentSetting, validChatPaymentPolicy } from '@/lib/chat-payment-policy'
import { CONFIG_KEYS } from '@agentjob/db'
import { ok, err } from '@/lib/api-response'
import { validFreeChatLimit } from '@/lib/free-chat-policy'
import { ATTACHMENT_LIMITS, validAttachmentSetting } from '@/lib/attachment-policy'
import { attachmentLimits } from '@/lib/chat-attachments'
import { z } from 'zod'
import { writeAuditLog, getClientIp } from '@/lib/audit'

const updateSchema = z.record(z.string(), z.string())

/** GET /api/admin/config */
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }
  const config = await getPlatformConfig()
  return ok({ ...config, ...await attachmentLimits() })
}

/** PATCH /api/admin/config */
export async function PATCH(req: NextRequest) {
  let adminSession
  try {
    adminSession = await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const body = await req.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return err('Invalid config data', 400)

  const validKeys = [...Object.values(CONFIG_KEYS), ...Object.keys(ATTACHMENT_LIMITS), ...CHAT_PAYMENT_CONFIG_KEYS] as string[]
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!validKeys.includes(key)) {
      return err(`Unknown config key: ${key}`, 400)
    }
    if (key === CONFIG_KEYS.SERVER_WALLET_WITHDRAWALS_ENABLED && !['true', 'false'].includes(value)) return err('Email-free withdrawals must be true or false', 400)
    if (key === CONFIG_KEYS.SERVER_WALLET_ENABLED && !['true', 'false'].includes(value)) return err('Email-free registration must be true or false', 400)
    if ((key === CONFIG_KEYS.SERVER_WALLET_DAILY_LIMIT || key === CONFIG_KEYS.SERVER_WALLET_IP_DAILY_LIMIT) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 10000)) return err('Registration limits must be whole numbers from 0 to 10000', 400)
    if (key === CONFIG_KEYS.PLATFORM_FEE_RATE && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 1)) return err('Platform fee rate must be at least 0 and less than 1', 400)
    if (!validAttachmentSetting(key, value)) return err('Invalid attachment limit: ' + key, 400)
    if (!validFreeChatLimit(key, value)) return err('Invalid free quota: ' + key, 400)
    if (!validChatPaymentSetting(key, value)) return err('Invalid chat payment setting: ' + key, 400)
  }
  if (Object.keys(parsed.data).some(key => CHAT_PAYMENT_CONFIG_KEYS.includes(key))) {
    const policy = { ...await getPlatformConfig() }
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === 'chat_payments_enabled') policy.chatPaymentsEnabled = value === 'true'
      if (key === 'chat_max_message_usdc') policy.chatMaxMessageUsdc = Number(value)
      if (key === 'chat_max_authorization_usdc') policy.chatMaxAuthorizationUsdc = Number(value)
      if (key === 'chat_authorization_minutes') policy.chatAuthorizationMinutes = Number(value)
    }
    if (!validChatPaymentPolicy(policy)) return err('Authorization budget maximum must cover the maximum message price', 400)
  }
  await updateConfigValues(parsed.data)

  writeAuditLog({
    userId: adminSession.userId,
    action: 'config_update',
    targetType: 'platform_config',
    metadata: parsed.data as Record<string, unknown>,
    ipAddress: getClientIp(req),
  })

  return ok({ message: 'Config updated' })
}
