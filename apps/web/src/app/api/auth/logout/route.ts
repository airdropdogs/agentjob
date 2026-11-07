import { getSession } from '@/lib/session'
import { ok } from '@/lib/api-response'

/** POST /api/auth/logout */
export async function POST() {
  const session = await getSession()
  session.destroy()
  return ok({ message: 'Logged out' })
}
