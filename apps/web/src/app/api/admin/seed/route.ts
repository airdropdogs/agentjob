import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq, count } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

const schema = z.object({
  email: z.string().email(),
  secret: z.string().min(1),
})

/**
 * POST /api/admin/seed
 *
 * Bootstrap: promote a user by email to admin (one-time).
 *
 * Runs only when:
 *   1. Body includes valid INTERNAL_API_SECRET
 *   2. No admin user exists yet in the DB
 *
 * Example:
 *   curl -X POST http://localhost:3000/api/admin/seed \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"your@email.com","secret":"YOUR_INTERNAL_API_SECRET"}'
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return err('email and secret required', 400)

  const { email, secret } = parsed.data

  if (secret !== process.env.INTERNAL_API_SECRET) {
    return err('Invalid secret', 403)
  }

  const db = getDb()

  // Abort if any admin already exists
  const [{ value: adminCount }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.role, 'admin'))

  if (Number(adminCount) > 0) {
    return err('Admin already exists. Use ADMIN_EMAILS env var to manage admins.', 409)
  }

  // Find target user
  const user = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (!user) {
    return err(`User with email "${email}" not found. Please register first.`, 404)
  }

  await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id))

  return ok({
    message: `User ${email} has been promoted to admin.`,
    userId: user.id,
  })
}
