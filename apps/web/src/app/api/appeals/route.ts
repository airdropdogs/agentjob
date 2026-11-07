import { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/session'
import { getDb } from '@/lib/db'
import { appeals, chats, agentProfiles, users } from '@agentjob/db'
import { eq, and, desc } from 'drizzle-orm'
import { ok, err, unauthorized } from '@/lib/api-response'

const createSchema = z.union([
  z.object({
    chatId: z.string().uuid(),
    reason: z.string().min(10).max(2000),
  }),
  z.object({
    agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    reason: z.string().min(10).max(2000),
  }),
])

/** POST /api/appeals — { chatId, reason } or { agentWallet, reason } (latest chat) */
export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return unauthorized()
  }

  const body = await req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid request', 400)

  const { reason } = parsed.data

  try {
    const db = getDb()
    let chatId: string

    if ('agentWallet' in parsed.data) {
      // Resolve agent by wallet → latest chat with user
      const agentUser = await db.query.users.findFirst({
        where: eq(users.wallet, parsed.data.agentWallet),
        columns: { id: true },
      })
      if (!agentUser) return err('Agent not found', 404)

      const agentProfile = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.userId, agentUser.id),
        columns: { id: true },
      })
      if (!agentProfile) return err('Agent profile not found', 404)

      const recentChat = await db.query.chats.findFirst({
        where: and(
          eq(chats.userId, session.userId),
          eq(chats.agentId, agentProfile.id),
        ),
        orderBy: [desc(chats.createdAt)],
        columns: { id: true, agentId: true },
      })
      if (!recentChat) return err('No paid conversation found with this agent', 404)
      chatId = recentChat.id
    } else {
      chatId = parsed.data.chatId
    }

    // Chat ownership
    const chat = await db.query.chats.findFirst({
      where: and(eq(chats.id, chatId), eq(chats.userId, session.userId)),
    })
    if (!chat) return err('Chat not found or not yours', 404)

    // One appeal per chat per user
    const existing = await db.query.appeals.findFirst({
      where: and(eq(appeals.chatId, chatId), eq(appeals.userId, session.userId)),
    })
    if (existing) return err('You already filed an appeal for this chat', 409)

    const [appeal] = await db
      .insert(appeals)
      .values({
        chatId,
        userId: session.userId,
        agentId: chat.agentId,
        reason,
      })
      .returning()

    return ok(appeal, 201)
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error('[appeals POST] error:', errMsg, e instanceof Error ? e.stack : '')
    return err('Internal error', 500)
  }
}

/** GET /api/appeals — current user's appeals */
export async function GET() {
  let session
  try {
    session = await requireAuth()
  } catch {
    return unauthorized()
  }

  const db = getDb()
  const list = await db.query.appeals.findMany({
    where: eq(appeals.userId, session.userId),
    orderBy: [desc(appeals.createdAt)],
  })

  return ok(list)
}
