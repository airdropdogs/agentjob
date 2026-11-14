type WalletUser = { evmSmartAccountObjects?: { address: string }[]; evmAccountObjects?: { address: string }[] } | null

/** Recover SDK state before signing; never create accounts or submit payments here. */
export async function ensurePaymentWallet(options: {
  expectedAddress: string
  initialized: () => boolean
  getUser: () => Promise<WalletUser>
  getToken: (options: { forceRefresh: boolean }) => Promise<string | null>
  timeoutMs?: number
}): Promise<string> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = async () => {
    while (!options.initialized()) {
      if (stopped) return ''
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    let token = await options.getToken({ forceRefresh: false })
    if (stopped) return ''
    if (!token) token = await options.getToken({ forceRefresh: true })
    if (stopped) return ''
    const user = await options.getUser()
    if (!token || !user) throw new Error('WALLET_CONNECTION_REQUIRED')
    const address = user.evmSmartAccountObjects?.[0]?.address ?? user.evmAccountObjects?.[0]?.address
    if (!address || address.toLowerCase() !== options.expectedAddress.toLowerCase()) throw new Error('WALLET_ACCOUNT_MISMATCH')
    return address
  }
  try {
    return await Promise.race([check(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WALLET_CONNECTION_TIMEOUT')), options.timeoutMs ?? 30_000)
    })])
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WALLET_')) throw error
    throw new Error('WALLET_CONNECTION_UNAVAILABLE')
  } finally { stopped = true; clearTimeout(timer) }
}
