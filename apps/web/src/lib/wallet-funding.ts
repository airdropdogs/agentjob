/** Verify the actual payer and compare exact USDC base units, never rounded display amounts. */
export function assertPaymentBalance(balance: { smartWallet?: string | null; usdcRaw?: string } | null | undefined, payer: string, needed: string) {
  if (!balance?.smartWallet || balance.smartWallet.toLowerCase() !== payer.toLowerCase() || !/^\d+$/.test(balance.usdcRaw ?? '') || !/^\d+$/.test(needed)) {
    throw new Error('Could not verify your payment wallet balance. Please retry shortly.')
  }
  if (BigInt(balance.usdcRaw!) < BigInt(needed)) throw new Error('Insufficient USDC balance')
}
