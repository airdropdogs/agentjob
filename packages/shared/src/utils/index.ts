export function formatUSDC(amount: string | number, decimals = 2): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  return num.toFixed(decimals)
}

export function truncateAddress(address: string, chars = 4): string {
  if (!address) return ''
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase()
}

export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function calcPlatformFee(amount: bigint, feePercent: number): bigint {
  return (amount * BigInt(feePercent)) / BigInt(100)
}

export function calcAgentShare(amount: bigint, feePercent: number): bigint {
  return amount - calcPlatformFee(amount, feePercent)
}
