/** HTTP success with updated=false is also a successful, idempotent binding. */
export async function bindWallet(wallet: string, token: string, request: typeof fetch = fetch) {
  const response = await request('/api/auth/session', {
    method: 'PATCH', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ wallet }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`WALLET_BIND_HTTP_${response.status}: Wallet setup could not be saved.`)
  if (result.data?.wallet?.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('WALLET_BIND_INVALID: Wallet setup could not be confirmed.')
  }
}
