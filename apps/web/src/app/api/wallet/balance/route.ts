import { getSession } from '@/lib/session'
import { ok, err, unauthorized } from '@/lib/api-response'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq } from 'drizzle-orm'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_RPC_URL = 'https://mainnet.base.org'

const ERC20_BALANCE_OF_ABI = {
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
} as const

/** GET /api/wallet/balance — Smart Wallet USDC on Base */
export async function GET() {
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const db = getDb()
  const user = await db.query.users.findFirst({
    columns: { wallet: true, bannedAt: true },
    where: eq(users.id, session.userId),
  })
  if (!user || user.bannedAt) return unauthorized()
  if (!user.wallet) return ok({ usdc: '0.00', usdcRaw: '0', smartWallet: null })

  try {
    const calldata = encodeBalanceOf(user.wallet as `0x${string}`)
    const rpcResp = await fetch(BASE_RPC_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDC_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const { result, error } = await rpcResp.json() as { result?: string; error?: unknown }
    if (!rpcResp.ok || error || !result || !/^0x[0-9a-f]+$/i.test(result)) {
      return err('Balance temporarily unavailable', 503)
    }
    const raw = BigInt(result)
    const usdcHuman = `${raw / BigInt(1_000_000)}.${(raw % BigInt(1_000_000)).toString().padStart(6, '0')}`
    return ok({ usdc: usdcHuman, usdcRaw: raw.toString(), smartWallet: user.wallet, transfersEnabled: process.env.ENABLE_REAL_PAYMENTS === 'true' })
  } catch {
    return err('Failed to fetch balance', 500)
  }
}

/** Manual balanceOf calldata (no viem bundle bloat) */
function encodeBalanceOf(address: `0x${string}`): string {
  const selector = '70a08231'
  const paddedAddress = address.slice(2).toLowerCase().padStart(64, '0')
  return `0x${selector}${paddedAddress}`
}
