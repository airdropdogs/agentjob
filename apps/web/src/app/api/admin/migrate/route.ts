import { NextRequest } from 'next/server'
import { getPool } from '@/lib/db'
import { ok, err } from '@/lib/api-response'

/**
 * POST /api/admin/migrate
 *
 * Run pending DB migrations manually (idempotent, IF NOT EXISTS).
 * Requires INTERNAL_API_SECRET in the body.
 *
 * Example:
 *   curl -X POST http://localhost:3000/api/admin/migrate \
 *     -H "Content-Type: application/json" \
 *     -d '{"secret":"YOUR_INTERNAL_API_SECRET"}'
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.secret || body.secret !== process.env.INTERNAL_API_SECRET) {
    return err('Invalid secret', 403)
  }

  const pool = getPool()

  const results: string[] = []

  // 0001_wallet_settings — idempotent create
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user_wallet_settings" (
        "user_id"               uuid PRIMARY KEY NOT NULL
          REFERENCES "public"."users"("id") ON DELETE CASCADE,
        "last_usdc_transfer_at" timestamp with time zone,
        "created_at"            timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at"            timestamp with time zone DEFAULT now() NOT NULL
      )
    `)
    results.push('user_wallet_settings: OK')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push(`user_wallet_settings: FAILED — ${msg}`)
  }

  return ok({ results })
}
