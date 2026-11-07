import { getIronSession, SessionOptions } from 'iron-session'
import { cookies } from 'next/headers'

export interface SessionData {
  userId: string
  email: string
  role: 'user' | 'admin'
  wallet?: string
  cdpVerified?: boolean
  cdpUserId?: string
  // CDP email OTP flow (pending state)
  pendingEmail?: string
  pendingFlowId?: string
}

const SESSION_OPTIONS: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'agentjob_session_v2',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
}

export async function getSession() {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, SESSION_OPTIONS)
}

export async function requireAuth(): Promise<SessionData> {
  const session = await getSession()
  if (!session.userId) {
    throw new Error('Unauthorized')
  }
  return session as SessionData
}

export async function requireAdmin(): Promise<SessionData> {
  const session = await requireAuth()
  if (session.role !== 'admin') {
    throw new Error('Forbidden')
  }
  return session
}
