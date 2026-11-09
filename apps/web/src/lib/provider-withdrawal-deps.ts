import { getPool } from './db'
import { getCdpClient } from './cdp-client'
import { getPlatformConfig } from './platform-config'
import { USDC, WithdrawalError, type WithdrawalDeps, type Receipt } from './provider-withdrawals'

function transferData(to: string, units: bigint): `0x${string}` {
  return `0xa9059cbb${to.slice(2).padStart(64, '0')}${units.toString(16).padStart(64, '0')}`
}
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch('https://mainnet.base.org', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json()
  if (!response.ok || body.error || !Object.hasOwn(body, 'result')) throw new WithdrawalError('BASE_RPC_UNAVAILABLE', 503)
  return body.result as T
}
export function withdrawalDependencies(): WithdrawalDeps {
  return {
    pool: getPool(), enabled: async () => (await getPlatformConfig()).serverWalletWithdrawalsEnabled, config: getPlatformConfig,
    async preflight(source, to, units) {
      const [balance, eth] = await Promise.all([
        rpc<string>('eth_call', [{ to: USDC, data: `0x70a08231${source.slice(2).padStart(64, '0')}` }, 'latest']),
        rpc<string>('eth_getBalance', [source, 'latest']),
      ])
      if (BigInt(balance) < units) throw new WithdrawalError('INSUFFICIENT_USDC')
      if (BigInt(eth) === BigInt(0)) throw new WithdrawalError('BASE_ETH_REQUIRED')
      const [gas, price] = await Promise.all([
        rpc<string>('eth_estimateGas', [{ from: source, to: USDC, data: transferData(to, units) }]),
        rpc<string>('eth_gasPrice', []),
      ])
      if (BigInt(eth) < BigInt(gas) * BigInt(price)) throw new WithdrawalError('INSUFFICIENT_BASE_ETH')
      // This is a preflight estimate, not a guarantee: Base L1 fees and prices can change.
    },
    async send(source, to, units, id) {
      const account = await getCdpClient().evm.getAccount({ address: source as `0x${string}` })
      if (account.address.toLowerCase() !== source.toLowerCase()) throw new Error('Wallet source mismatch')
      const { transactionHash } = await account.sendTransaction({
        network: 'base', idempotencyKey: id,
        transaction: { to: USDC, value: BigInt(0), data: transferData(to, units) },
      })
      return transactionHash
    },
    async receipt(hash) {
      const [receipt, block] = await Promise.all([
        rpc<Receipt | null>('eth_getTransactionReceipt', [hash]), rpc<string>('eth_blockNumber', []),
      ])
      return { receipt, block: BigInt(block) }
    },
  }
}
