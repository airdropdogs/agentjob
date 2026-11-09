import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { users, agentProfiles } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { createHash } from 'node:crypto'
import { generateApiKey, hashApiKey, generateRandomAgentName } from '@/lib/utils'
import { getCdpClient } from '@/lib/cdp-client'
import { getPlatformConfig } from '@/lib/platform-config'
import {
  incrementServerWalletDailyCount,
  decrementServerWalletDailyCount,
  getServerWalletDailyCount,
  withRegisterAutoLock,
  idempotencyHttpGet,
  idempotencyHttpSet,
} from '@/lib/rate-limit'
import { writeAuditLog, getClientIp } from '@/lib/audit'
import { ipRegisterLimit } from '@/lib/redis-limiters'

const schema = z.object({
  agentName: z.string().min(1).max(100).optional(),
  /**
   * Stable caller-supplied key (e.g. a UUID burned into the agent binary).
   * When provided the response is cached 24 h so duplicate calls return the
   * same payload without creating a second account.
   */
  // users.cdp_account_name is varchar(100); prefix "agentjob-sw-" is 12 chars → key max 88
  idempotencyKey: z.string().min(1).max(88).optional(),
})

/**
 * POST /api/register/auto
 *
 * No-email registration via CDP Server Wallet v2.
 * Subject to a daily platform quota and an on/off toggle (platform_config).
 * Idempotent when `idempotencyKey` is supplied.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid request', 400)

  const { agentName, idempotencyKey } = parsed.data
  const ip = getClientIp(req)
  const config = await getPlatformConfig()

  // ── Per-IP daily limit (2/day) ─────────────────────────────────────────────
  if (ipRegisterLimit && ip) {
    let success: boolean
    try {
      success = (await ipRegisterLimit.limit(`ip:${ip}`, config.serverWalletIpDailyLimit)).success
    } catch {
      return err('Registration temporarily unavailable. Please try again later.', 503)
    }
    if (!success) {
      return err(`Too many registration requests from this IP today (limit: ${config.serverWalletIpDailyLimit}/day). Try again tomorrow or register at https://agent-job.ai.`, 429)
    }
  }

  // ── Idempotency cache (24 h) — required Redis check ──────────────────────
  if (idempotencyKey) {
    try {
      const cached = await idempotencyHttpGet(`sw:reg:${idempotencyKey}`)
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: { 'Content-Type': 'application/json', ...cached.headers },
        })
      }
    } catch (e) {
      return err('Registration temporarily unavailable. Please try again later.', 503)
    }
  }

  // ── Platform config ───────────────────────────────────────────────────────
  if (!config.serverWalletEnabled) {
    return err('Server Wallet registration is currently disabled. Register at https://agent-job.ai', 503)
  }

  // Date key for daily quota  (UTC date string, e.g. "2026-03-20")
  const today = new Date().toISOString().slice(0, 10)

  // ── Quick quota pre-check (non-atomic, fast) — required Redis check ──────
  try {
    const currentCount = await getServerWalletDailyCount(today)
    if (currentCount >= config.serverWalletDailyLimit) {
      const quotaResetAt = new Date(`${today}T00:00:00Z`)
      quotaResetAt.setUTCDate(quotaResetAt.getUTCDate() + 1)
      return err(
        `Daily Server Wallet quota exceeded (${config.serverWalletDailyLimit}/day). ` +
        `Register at https://agent-job.ai or retry after ${quotaResetAt.toISOString()}.`,
        429,
      )
    }
  } catch (e) {
    return err('Registration temporarily unavailable. Please try again later.', 503)
  }

  // ── Core registration: CDP + DB (Redis lock required) ───────────────
  try {
    const lockResult = await withRegisterAutoLock(today, async () => {
      const count = await incrementServerWalletDailyCount(today)
      if (count > config.serverWalletDailyLimit) {
        await decrementServerWalletDailyCount(today).catch(() => {})
        throw Object.assign(new Error('quota'), { quota: true })
      }

      // CDP account name: alphanumeric + hyphens, 2-36 chars
      const cdpAccountName = idempotencyKey
        ? `aj-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
        : `aj-${crypto.randomUUID().replaceAll('-', '')}`

      const cdp = getCdpClient()
      const account = await cdp.evm.getOrCreateAccount({ name: cdpAccountName })
      const walletAddress = account.address as string

      const virtualEmail = `${cdpAccountName}@wallet.agentjob.ai`

      const db = getDb()
      let user = await db.query.users.findFirst({ where: eq(users.email, virtualEmail) })

      if (!user) {
        const [newUser] = await db
          .insert(users)
          .values({
            email: virtualEmail,
            wallet: walletAddress,
            walletType: 'server_wallet',
            cdpAccountName,
            walletSourceIp: ip ?? null,
          })
          .returning()
        user = newUser
      }

      let existingAgent = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.userId, user.id),
      })

      let apiKey: string | null = null
      let agentId: string

      if (existingAgent) {
        agentId = existingAgent.id
      } else {
        apiKey = generateApiKey()
        const [created] = await db
          .insert(agentProfiles)
          .values({
            userId: user.id,
            name: agentName ?? generateRandomAgentName(),
            priceSubsequent: '0.01',
            priceFirstMsg: '0.01',
            freeDailyMax: 5,
            apiKeyHash: hashApiKey(apiKey),
            customSkillTags: [],
          })
          .returning({ id: agentProfiles.id })
        agentId = created.id
      }

      return { user, agentId, walletAddress, apiKey, cdpAccountName }
    })

    if (!lockResult.ok) {
      return err('Registration temporarily busy. Retry in a few seconds.', 503)
    }

    const { agentId, walletAddress, apiKey, user } = lockResult.value

    writeAuditLog({
      userId: user.id,
      action: 'agent_register',
      targetType: 'user',
      targetId: user.id,
      metadata: { walletType: 'server_wallet', agentId },
      ipAddress: ip,
    })

    const payload = {
      ok: true,
      data: {
        agentId,
        walletAddress,
        walletType: 'server_wallet',
        apiKey,
        message: apiKey
          ? 'Registration complete. Save your API key — it will not be shown again. Set AGENTJOB_API_KEY=<key> and restart agentjob.'
          : 'Agent already registered. API key was issued at first registration.',
      },
    }

    const responseBody = JSON.stringify(payload)
    const responseHeaders = { 'Content-Type': 'application/json' }

    // Persist the idempotent response before reporting success.
    if (idempotencyKey && apiKey) {
      await idempotencyHttpSet(`sw:reg:${idempotencyKey}`, {
        status: 201,
        body: responseBody,
        headers: responseHeaders,
      })
    }

    return new Response(responseBody, { status: 201, headers: responseHeaders })
  } catch (e) {
    const isQuota =
      e !== null &&
      typeof e === 'object' &&
      'quota' in e &&
      (e as { quota?: boolean }).quota === true
    if (isQuota) {
      const quotaResetAt = new Date(`${today}T00:00:00Z`)
      quotaResetAt.setUTCDate(quotaResetAt.getUTCDate() + 1)
      return err(
        `Daily Server Wallet quota exceeded (${config.serverWalletDailyLimit}/day). ` +
          `Register at https://agent-job.ai or retry after ${quotaResetAt.toISOString()}.`,
        429,
      )
    }
    console.error('[POST /api/register/auto]', e)
    return err('Registration could not be completed. Please try again later.', 500)
  }
}
