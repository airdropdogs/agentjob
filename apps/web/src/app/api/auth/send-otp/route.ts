import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { ok, err } from '@/lib/api-response'
import { rateLimitIdHash, redisLimiters } from '@/lib/rate-limit'

const schema = z.object({
  email: z.string().email(),
})

/** POST send-otp — CDP email OTP; returns flowId */
export async function POST(req: NextRequest) {
  console.log('[auth/send-otp] start')
  console.log('[auth/send-otp] CDP_PROJECT_ID set:', !!process.env.CDP_PROJECT_ID, '=', process.env.CDP_PROJECT_ID)
  console.log('[auth/send-otp] SESSION_SECRET set:', !!process.env.SESSION_SECRET)

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return err('Invalid email', 400)
  }

  const { email } = parsed.data
  console.log('[auth/send-otp] sending OTP to:', email)

  if (redisLimiters) {
    const { success } = await redisLimiters.otpEmailLimit.limit(rateLimitIdHash(email))
    if (!success) {
      return err('Too many OTP requests for this email. Please wait before trying again.', 429)
    }
  }

  try {
    const cdpUrl = 'https://api.cdp.coinbase.com/platform/v2/auth/email/otp'
    console.log('[auth/send-otp] calling CDP:', cdpUrl)
    const cdpResp = await fetch(cdpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDP-Project-Id': process.env.CDP_PROJECT_ID!,
      },
      body: JSON.stringify({ email }),
    })

    console.log('[auth/send-otp] CDP status:', cdpResp.status, cdpResp.statusText)
    if (!cdpResp.ok) {
      const text = await cdpResp.text()
      console.error('[auth/send-otp] CDP error body:', text)
      return err('Failed to send OTP', 502)
    }

    const respJson = await cdpResp.json()
    console.log('[auth/send-otp] CDP response JSON:', respJson)
    const { flow_id: flowId } = respJson

    const session = await getSession()
    session.pendingEmail = email
    session.pendingFlowId = flowId as string
    await session.save()

    return ok({ flowId, message: 'OTP sent' })
  } catch (e) {
    console.error('[auth/send-otp] exception:', e)
    return err('Internal error', 500)
  }
}
