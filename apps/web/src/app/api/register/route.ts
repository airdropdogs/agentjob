import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { users, agentProfiles } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { generateApiKey, hashApiKey, generateRandomAgentName } from '@/lib/utils'

const schema = z.object({
  email: z.string().email(),
  flowId: z.string().min(1),
  otp: z.string().length(6),
  /** Optional: override the auto-generated agent name */
  agentName: z.string().min(1).max(100).optional(),
})

/**
 * POST /api/register
 * Stateless registration for agents/bots — no browser session / cookie required.
 * Flow:
 *   1. Caller gets flowId from POST /api/auth/send-otp (returns { flowId })
 *   2. User reads OTP from email, provides it here alongside email + flowId
 *   3. We verify with CDP, upsert user, auto-create agent profile, return API key
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return err(parsed.error.issues[0]?.message ?? 'Invalid request', 400)
  }

  const { email, flowId, otp, agentName } = parsed.data

  // ── 1. Verify OTP with Coinbase CDP ──────────────────────────────────────
  let walletAddress: string | null = null
  try {
    const cdpResp = await fetch('https://api.cdp.coinbase.com/platform/v2/auth/email/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDP-Project-Id': process.env.CDP_PROJECT_ID!,
      },
      body: JSON.stringify({ flow_id: flowId, otp }),
    })

    if (!cdpResp.ok) {
      return err('Invalid OTP or expired', 400)
    }

    const json = await cdpResp.json()
    walletAddress = json.wallet_address ?? null
  } catch {
    return err('Failed to verify OTP', 502)
  }

  // ── 2. Upsert user ────────────────────────────────────────────────────────
  const db = getDb()
  let user = await db.query.users.findFirst({ where: eq(users.email, email) })

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({ email, wallet: walletAddress, emailVerifiedAt: new Date() })
      .returning()
    user = newUser
  } else {
    if (user.bannedAt) return err('Account is banned', 403)
    if (!user.emailVerifiedAt) {
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date(), wallet: walletAddress ?? user.wallet })
        .where(eq(users.id, user.id))
    }
  }

  // ── 3. Auto-create agent (skip if already registered) ────────────────────
  const existing = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.userId, user.id),
  })

  let returnedApiKey: string | null = null
  let agentId: string

  if (existing) {
    agentId = existing.id
    // Return null key; user should use Dashboard to reset key if needed
  } else {
    returnedApiKey = generateApiKey()
    const [created] = await db
      .insert(agentProfiles)
      .values({
        userId: user.id,
        name: agentName ?? generateRandomAgentName(),
        priceSubsequent: '0.01',
        priceFirstMsg: '0.01',
        freeDailyMax: 5,
        apiKeyHash: hashApiKey(returnedApiKey),
        customSkillTags: [],
      })
      .returning({ id: agentProfiles.id })
    agentId = created.id
  }

  return ok({
    agentId,
    walletAddress: walletAddress ?? user.wallet,
    /** Only returned on first registration. null if agent already existed. */
    apiKey: returnedApiKey,
    alreadyRegistered: existing != null,
    message: existing
      ? 'Agent already registered. Use the Dashboard to manage your API key.'
      : 'Agent registered. Save your API key — it will not be shown again.',
  })
}
