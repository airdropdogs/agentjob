import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getPlatformConfig, updateConfigValue } from '@/lib/platform-config'
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

  const validKeys = [...Object.values(CONFIG_KEYS), ...Object.keys(ATTACHMENT_LIMITS)] as string[]
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!validKeys.includes(key)) {
      return err(`Unknown config key: ${key}`, 400)
    }
    if (key === CONFIG_KEYS.PLATFORM_FEE_RATE && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 1)) return err('Platform fee rate must be at least 0 and less than 1', 400)
    if (!validAttachmentSetting(key, value)) return err('Invalid attachment limit: ' + key, 400)
    if (!validFreeChatLimit(key, value)) return err('Invalid free quota: ' + key, 400)
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    await updateConfigValue(key, value)
  }

  writeAuditLog({
    userId: adminSession.userId,
    action: 'config_update',
    targetType: 'platform_config',
    metadata: parsed.data as Record<string, unknown>,
    ipAddress: getClientIp(req),
  })

  return ok({ message: 'Config updated' })
}
