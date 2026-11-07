import { CdpClient } from '@coinbase/cdp-sdk'

let _cdp: CdpClient | null = null

/**
 * Returns a singleton CDP client configured for Server Wallet v2.
 * CDP_API_KEY_ID, CDP_API_KEY_SECRET are shared with the existing CDP Email OTP flow.
 * CDP_WALLET_SECRET is exclusive to Server Wallet v2 — treat it as a master key.
 */
export function getCdpClient(): CdpClient {
  if (!_cdp) {
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET
    const walletSecret = process.env.CDP_WALLET_SECRET

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      throw new Error('Missing CDP credentials: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET must be set')
    }

    _cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret })
  }
  return _cdp
}
