'use client'

import { useEffect, useRef, useState } from 'react'
import { walletReadiness } from '@/lib/wallet-readiness'
import { DepositDialog } from '@/components/wallet/deposit-dialog'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  useEvmAccounts,
  useIsInitialized,
  useIsSignedIn,
  useEvmKeyExportIframe,
  useSendEvmSmartAccountUsdc,
} from '@coinbase/cdp-hooks'
import {
  Wallet, Copy, Check, ExternalLink, RefreshCw, AlertTriangle,
  Send, ChevronLeft, Loader2, Key,
} from 'lucide-react'
import { shortWallet } from '@/lib/utils'
import { cn } from '@/lib/utils'

interface SessionUser { userId: string; email: string; wallet?: string }
interface BalanceData { usdc: string; usdcRaw: string; smartWallet: string | null }
interface TransferStatus {
  canTransfer: boolean
  lastTransferAt: string | null
  nextTransferAt: string | null
  minAmount: string
  cooldownDays: number
  smartWallet: string | null
}

export default function WalletPage() {
  const router = useRouter()
  const qc = useQueryClient()

  const { data: session } = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  if (!session) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card rounded-xl w-48" />
          <div className="h-40 bg-card rounded-2xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.back()}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
          <Wallet className="w-4 h-4 text-primary" />
        </div>
        <h1 className="text-xl font-bold">Wallet</h1>
      </div>

      <div className="space-y-4">
        <BalanceCard smartWallet={session.wallet ?? null} onRefresh={() => qc.invalidateQueries({ queryKey: ['wallet-balance'] })} />
        <TransferCard smartWallet={session.wallet ?? null} onSuccess={() => qc.invalidateQueries({ queryKey: ['wallet-transfer-status'] })} />
        <EoaCard />
      </div>
    </div>
  )
}

/* Balance */
function BalanceCard({ smartWallet, onRefresh }: { smartWallet: string | null; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false)
  const [depositOpen, setDepositOpen] = useState(false)

  const { data: balance, isLoading, refetch } = useQuery<BalanceData>({
    queryKey: ['wallet-balance'],
    queryFn: async () => {
      const res = await fetch('/api/wallet/balance')
      const { data } = await res.json()
      return data
    },
    enabled: !!smartWallet,
    refetchOnWindowFocus: false,
  })

  function copy(addr: string) {
    navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-card border border-border/40 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground">USDC balance</h2>
        <button
          onClick={() => { refetch(); onRefresh() }}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn('w-3.5 h-3.5 text-muted-foreground', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {isLoading ? (
          <div className="h-10 w-32 bg-secondary rounded-xl animate-pulse" />
        ) : (
          <p className="text-3xl font-bold">{balance?.usdc ?? '0.00'} <span className="text-base font-normal text-muted-foreground">USDC</span></p>
        )}
        <button type="button" disabled={!smartWallet} onClick={() => setDepositOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed">
          <Wallet className="h-4 w-4" />Add funds
        </button>
      </div>
      <DepositDialog open={depositOpen} onOpenChange={(open) => { setDepositOpen(open); if (!open) onRefresh() }} address={smartWallet} />

      {smartWallet && (
        <div className="flex items-center justify-between bg-secondary/50 rounded-xl px-3 py-2">
          <div>
            <p className="text-[10px] text-muted-foreground mb-0.5">Smart Wallet</p>
            <p className="text-xs font-mono">
              <span className="hidden sm:inline">{smartWallet}</span>
              <span className="sm:hidden">{shortWallet(smartWallet)}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button type="button" onClick={() => copy(smartWallet)} className="p-1.5 hover:bg-secondary rounded-lg transition-colors" title="Copy">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
            <a
              href={`https://basescan.org/address/${smartWallet}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              title="BaseScan"
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
          </div>
        </div>
      )}

      {!smartWallet && (
        <p className="text-xs text-muted-foreground/70">Wallet not ready yet—send a chat message to finish setup.</p>
      )}
    </div>
  )
}

/* Transfer */
function TransferCard({ smartWallet, onSuccess }: { smartWallet: string | null; onSuccess: () => void }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const { sendEvmSmartAccountUsdc } = useSendEvmSmartAccountUsdc()

  const { data: status, isLoading: statusLoading } = useQuery<TransferStatus>({
    queryKey: ['wallet-transfer-status'],
    queryFn: async () => {
      const res = await fetch('/api/wallet/transfer-status')
      if (!res.ok) return null
      const { data } = await res.json()
      return data ?? null
    },
    refetchOnWindowFocus: false,
  })

  const transferMutation = useMutation({
    mutationFn: async ({ to, amount }: { to: string; amount: string }) => {
      setError('')
      setSuccess('')

      // 1. Server validate
      const validateRes = await fetch('/api/wallet/transfer/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, amount }),
      })
      const validateJson = await validateRes.json()
      if (!validateRes.ok) throw new Error(validateJson.error ?? 'Validation failed')

      // 2. Client transfer (CDP, paymaster gas)
      const result = await sendEvmSmartAccountUsdc({
        evmSmartAccount: smartWallet as `0x${string}`,
        to: to as `0x${string}`,
        amount,
        network: 'base',
        useCdpPaymaster: true,
      })

      // 3. Record
      await fetch('/api/wallet/transfer/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, amount, userOpHash: result.userOpHash }),
      })

      return result
    },
    onSuccess: (result) => {
      setSuccess(`Sent. UserOp: ${result.userOpHash.slice(0, 18)}...`)
      setTo('')
      setAmount('')
      onSuccess()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  if (!smartWallet) return null

  const nextTransferDate = status?.nextTransferAt
    ? new Date(status.nextTransferAt).toLocaleDateString('en-US')
    : null

  return (
    <div className="bg-card border border-border/40 rounded-2xl p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-4">Send USDC</h2>

      {statusLoading ? (
        <div className="h-24 bg-secondary rounded-xl animate-pulse" />
      ) : !status ? (
        <div className="bg-secondary/60 rounded-xl p-4 text-sm text-muted-foreground text-center">
          <p>Could not load transfer status. Refresh and try again.</p>
        </div>
      ) : !status.canTransfer ? (
        <div className="bg-secondary/60 rounded-xl p-4 text-sm text-muted-foreground">
          <p>
            Cooldown. Next transfer after:{' '}
            <span className="font-medium text-foreground">{nextTransferDate ?? '—'}</span>
          </p>
          <p className="text-xs mt-1.5 opacity-70">
            One sponsored transfer per <span className="font-medium">{status.cooldownDays}</span> days. For unlimited
            sends,{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => document.getElementById('eoa-section')?.scrollIntoView({ behavior: 'smooth' })}
            >
              export your key
            </button>{' '}
            and use MetaMask.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">To address</label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x..."
              className="w-full px-3 py-2.5 bg-secondary border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">
              Amount (USDC, min {status.minAmount})
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              min={status.minAmount}
              step="0.01"
              className="w-full px-3 py-2.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Gas sponsored · once per {status.cooldownDays} days · Base
          </p>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-red-500/10 text-red-400 rounded-xl text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="px-3 py-2.5 bg-emerald-500/10 text-emerald-500 rounded-xl text-sm">
              {success}
            </div>
          )}

          <button
            onClick={() => transferMutation.mutate({ to, amount })}
            disabled={transferMutation.isPending || !to || !amount}
            className="flex items-center justify-center gap-2 w-full py-2.5 bg-primary hover:bg-primary/90 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {transferMutation.isPending
              ? <><Loader2 className="w-4 h-4 animate-spin" />Sending...</>
              : <><Send className="w-4 h-4" />Send</>}
          </button>
        </div>
      )}
    </div>
  )
}

/* EOA & key export */
function EoaCard() {
  const { evmAccounts } = useEvmAccounts()
  const { isInitialized } = useIsInitialized()
  const { isSignedIn } = useIsSignedIn()
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setTimedOut(true), 30000); return () => clearTimeout(timer) }, [])
  const [showExport, setShowExport] = useState(false)
  const [agreed, setAgreed] = useState(false)
  // Checkbox enables button; confirm activates iframe
  const [confirmed, setConfirmed] = useState(false)
  const [copied, setCopied] = useState(false)

  const eoaAddress = evmAccounts?.[0]?.address ?? null

  const readiness = walletReadiness({ initialized: isInitialized, signedIn: isSignedIn, address: eoaAddress, timedOut })
  const reauthenticate = '/login?from=%2Fdashboard%2Fwallet'

  function handleClose() {
    setShowExport(false)
    setAgreed(false)
    setConfirmed(false)
  }

  function copyEoa() {
    if (!eoaAddress) return
    navigator.clipboard.writeText(eoaAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }


  return (
    <div id="eoa-section" className="bg-card border border-border/40 rounded-2xl p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-4">EOA (owner wallet)</h2>

      {readiness === 'ready' && eoaAddress ? (
        <div className="flex items-center justify-between bg-secondary/50 rounded-xl px-3 py-2 mb-3">
          <div>
            <p className="text-[10px] text-muted-foreground mb-0.5">EOA (Embedded Wallet)</p>
            <p className="text-xs font-mono">
              <span className="hidden sm:inline">{eoaAddress}</span>
              <span className="sm:hidden">{shortWallet(eoaAddress)}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button type="button" onClick={copyEoa} className="p-1.5 hover:bg-secondary rounded-lg transition-colors" title="Copy">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
            <a
              href={`https://basescan.org/address/${eoaAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              title="BaseScan"
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
          </div>
        </div>
      ) : (
        <div className="bg-secondary/30 rounded-xl px-3 py-3 mb-3 text-xs">
          {readiness === 'loading' ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading owner wallet...</p> : <>
            <p role="status" className="text-muted-foreground">{readiness === 'reauth' ? 'Your wallet session needs verification. You are still signed in to AgentJob.' : 'The owner wallet could not be loaded. Reconnect your wallet session or retry the page.'}</p>
            <a href={reauthenticate} className="inline-block mt-2 text-primary underline">Verify wallet session</a>
            <p className="mt-1 text-muted-foreground">Use the same email as this account to restore your existing wallet.</p>
            {readiness === 'unavailable' && <button type="button" className="mt-2 underline" onClick={() => window.location.reload()}>Retry loading</button>}
          </>}
        </div>
      )}

      <p className="text-xs text-muted-foreground mb-3">
        The EOA owns your Smart Wallet. Export the key to self-custody with MetaMask or similar.
      </p>

      <button
        type="button"
        disabled={readiness !== 'ready'}
        onClick={() => setShowExport(true)}
        className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/15 text-amber-500 rounded-xl text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Key className="w-4 h-4" />
        Export private key
      </button>

      {showExport && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md">
            {!confirmed ? (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                  <h3 className="font-semibold">Export private key — risks</h3>
                </div>
                <ol className="text-sm text-muted-foreground space-y-2 mb-5 list-decimal list-inside">
                  <li>Full control of funds—anyone with the key can drain the wallet</li>
                  <li>Do not screenshot, share, or store on networked devices</li>
                  <li>Prefer moving to a hardware or air-gapped wallet after export</li>
                  <li>After export you can use MetaMask etc. without platform limits</li>
                </ol>
                <label className="flex items-start gap-2.5 cursor-pointer mb-5">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm">I understand and want to export</span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 py-2.5 bg-secondary rounded-xl text-sm hover:bg-secondary/70 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!agreed || readiness !== 'ready'}
                    onClick={() => setConfirmed(true)}
                    className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-500/90 text-white rounded-xl text-sm transition-colors disabled:opacity-40"
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-sm">Private key (secure iframe)</h3>
                  <button type="button" onClick={handleClose} className="text-xs text-muted-foreground hover:text-foreground">
                    Close
                  </button>
                </div>
                {readiness !== 'ready' || !eoaAddress ? (
                  <p className="text-sm text-muted-foreground">Wallet session unavailable. Close this dialog and verify your wallet session.</p>
                ) : <PrivateKeyFrame address={eoaAddress} />}

              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Mounted only after the user explicitly confirms export; unmount removes the secure frame.
function PrivateKeyFrame({ address }: { address: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const { status, cleanup } = useEvmKeyExportIframe({ address, containerRef, label: 'Your private key', copiedLabel: 'Copied', icon: true })
  useEffect(() => {
    if (status === 'error' || status === 'expired') {
      setProblem(status === 'expired' ? 'The secure export session expired. Close this dialog and try again.' : 'Coinbase secure export could not be opened. Close this dialog and verify your wallet session. The secure frame also requires a working connection to Coinbase.')
      cleanup()
    }
  }, [status, cleanup])
  useEffect(() => {
    if (problem || status === 'ready' || status === 'success') return
    const timer = setTimeout(() => { setProblem('The Coinbase secure export frame timed out. Close this dialog and try again on a network that can reach Coinbase.'); cleanup() }, 30000)
    return () => clearTimeout(timer)
  }, [status, problem, cleanup])
  return <>
    <p className="text-xs text-muted-foreground mb-3">Shown in a Coinbase secure iframe; not readable by this page's JavaScript.</p>
    {problem ? <p role="alert" className="text-sm text-amber-500">{problem}</p> : <>
      {status !== 'ready' && status !== 'success' && <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Opening Coinbase secure export...</p>}
      <div ref={containerRef} className="min-h-[80px]" />
    </>}
  </>
}
