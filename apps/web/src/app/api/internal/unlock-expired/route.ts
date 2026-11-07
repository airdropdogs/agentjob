import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import { agentProfiles } from '@agentjob/db'
import { isNotNull, lt, and, eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

const LOCK_TIMEOUT_MS = 30 * 60 * 1000

/** Release exclusive activeChatId stale >30min. Cron / x-internal-secret */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    return err('Forbidden', 403)
  }

  const db = getDb()
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS)

  // Agents stuck in exclusive lock
  const stuckAgents = await db.query.agentProfiles.findMany({
    where: and(
      isNotNull(agentProfiles.activeChatId),
      lt(agentProfiles.lastMessageAt, cutoff)
    ),
    columns: { id: true, activeChatId: true, lastMessageAt: true },
  })

  if (stuckAgents.length === 0) {
    return ok({ released: 0, message: 'No expired locks found' })
  }

  // Clear locks
  let released = 0
  for (const agent of stuckAgents) {
    try {
      const cleared = await db
        .update(agentProfiles)
        .set({ activeChatId: null, updatedAt: new Date() })
        .where(
          and(
            eq(agentProfiles.id, agent.id),
            isNotNull(agentProfiles.activeChatId),
            lt(agentProfiles.lastMessageAt, cutoff)
          )
        )
        .returning({ id: agentProfiles.id })
      released += cleared.length
    } catch {
      // ignore per-row errors
    }
  }

  console.log(`[unlock-expired] Released ${released} expired locks`)
  return ok({ released, message: `Released ${released} expired lock(s)` })
}

/** GET alias for Vercel Cron */
export async function GET(req: NextRequest) {
  const secret =
    req.headers.get('x-internal-secret') ??
    new URL(req.url).searchParams.get('secret')

  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    return err('Forbidden', 403)
  }

  const db = getDb()
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS)

  const stuckAgents = await db.query.agentProfiles.findMany({
    where: and(
      isNotNull(agentProfiles.activeChatId),
      lt(agentProfiles.lastMessageAt, cutoff)
    ),
    columns: { id: true },
  })

  if (stuckAgents.length === 0) {
    return ok({ released: 0 })
  }

  await db
    .update(agentProfiles)
    .set({ activeChatId: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(agentProfiles.activeChatId),
        lt(agentProfiles.lastMessageAt, cutoff)
      )
    )

  console.log(`[unlock-expired] Released ${stuckAgents.length} expired lock(s)`)
  return ok({ released: stuckAgents.length })
}
