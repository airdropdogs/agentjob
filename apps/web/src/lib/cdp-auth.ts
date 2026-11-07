import { CdpClient } from '@coinbase/cdp-sdk'

type VerifiedEndUser = {
  userId: string
  authenticationMethods: { type: string; email?: string }[]
  evmAccounts?: string[]
  evmSmartAccounts?: string[]
  evmAccountObjects?: { address: string }[]
  evmSmartAccountObjects?: { address: string }[]
}

let client: CdpClient | undefined
async function validateAccessToken(accessToken: string): Promise<VerifiedEndUser> {
  client ??= new CdpClient({ apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET })
  return client.endUser.validateAccessToken({ accessToken })
}

export async function verifyCdpIdentity(
  request: Request,
  expectedEmail?: string,
  requestedWallet?: string,
  validate = validateAccessToken,
) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  if (!bearer || bearer.length > 16384) throw new Error('Authentication required')
  const user = await validate(bearer)
  const emails = user.authenticationMethods
    .filter(method => method.type === 'email' && method.email)
    .map(method => method.email!.trim().toLowerCase())
  const email = expectedEmail?.trim().toLowerCase() ?? emails[0]
  if (!user.userId || !email || !emails.includes(email)) throw new Error('Identity mismatch')
  const wallets = [...new Set([
    ...(user.evmSmartAccounts ?? []), ...(user.evmAccounts ?? []),
    ...(user.evmSmartAccountObjects ?? []).map(account => account.address),
    ...(user.evmAccountObjects ?? []).map(account => account.address),
  ].filter(address => /^0x[0-9a-fA-F]{40}$/.test(address)).map(address => address.toLowerCase()))]
  if (requestedWallet && !wallets.includes(requestedWallet.toLowerCase())) throw new Error('Wallet ownership mismatch')
  return { userId: user.userId, email, wallets, wallet: requestedWallet?.toLowerCase() ?? wallets[0] }
}
