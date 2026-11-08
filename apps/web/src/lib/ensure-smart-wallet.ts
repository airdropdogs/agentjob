import { createEvmSmartAccount, getCurrentUser } from '@coinbase/cdp-core'

// Keep the actual SDK operation locked even if a caller's UI timeout expires.
let pending: Promise<string> | undefined
export function ensureSmartWallet() {
  if (!pending) {
    pending = (async () => {
      const user = await getCurrentUser()
      if (!user) throw new Error('WALLET_SIGN_IN_REQUIRED: Please sign in again to finish wallet setup.')
      const existing = user.evmSmartAccountObjects?.[0]?.address ?? user.evmSmartAccounts?.[0]
      if (existing) return existing
      // Reuse an owner left by an interrupted setup instead of consuming another EOA slot.
      const owner = user.evmAccountObjects?.find(account =>
        !user.evmSmartAccountObjects?.some(smart => smart.ownerAddresses.includes(account.address)))?.address
      return await createEvmSmartAccount(owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? { owner: owner as `0x${string}` } : undefined)
    })().finally(() => { pending = undefined })
  }
  return pending
}
