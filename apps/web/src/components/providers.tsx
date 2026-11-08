'use client'

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ensureSmartWallet } from '@/lib/ensure-smart-wallet'
import { bindWallet } from '@/lib/wallet-sync'
import { withLoginTimeout } from '@/lib/login-session'
import { Toaster } from '@/components/ui/toaster'
import { installCdpProxy } from '@/lib/cdp-proxy-client'
import { getAccessToken } from '@coinbase/cdp-core'
import { CDPHooksProvider, useIsInitialized, useIsSignedIn } from '@coinbase/cdp-hooks'

const CDP_PROJECT_ID = process.env.NEXT_PUBLIC_CDP_PROJECT_ID!

export function Providers({ children }: { children: React.ReactNode }) {
  const [transportReady, setTransportReady] = useState(false)
  useEffect(() => {
    const option = new URLSearchParams(window.location.search).get('cdp_proxy')
    let enabled = option !== '0'
    try {
      if (option === '1' || option === '0') sessionStorage.setItem('agentjob_cdp_transport', option)
      enabled = sessionStorage.getItem('agentjob_cdp_transport') !== '0'
      sessionStorage.setItem('agentjob_cdp_transport', enabled ? '1' : '0')
    } catch { /* Query parameter still works when session storage is unavailable. */ }
    const restore = enabled ? installCdpProxy(CDP_PROJECT_ID) : undefined
    setTransportReady(true)
    return restore
  }, [])
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
          },
        },
      })
  )

  if (!transportReady) return <div role="status" className="p-6 text-sm text-muted-foreground">Loading...</div>
  return (
    <CDPHooksProvider config={{ projectId: CDP_PROJECT_ID, disableAnalytics: true }}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
        <WalletSyncer />
      </QueryClientProvider>
    </CDPHooksProvider>
  )
}

/** Recover incomplete wallet setup without an automatic retry loop. */
function WalletSyncer() {
  const { isSignedIn } = useIsSignedIn()
  const { isInitialized } = useIsInitialized()
  const pathname = usePathname()
  const qc = useQueryClient()
  const { data: session } = useQuery<{ userId?: string; wallet?: string } | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      return res.ok ? (await res.json()).data : null
    },
  })
  const recovery = useQuery({
    queryKey: ['wallet-setup', session?.userId],
    enabled: !!session?.userId && !session.wallet && isInitialized && isSignedIn && pathname !== '/login',
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async () => {
      let wallet: string
      try { wallet = await withLoginTimeout(ensureSmartWallet()) }
      catch { throw new Error('WALLET_CREATE_FAILED: Wallet creation did not finish. Check your connection and retry, or sign in again.') }
      const token = await withLoginTimeout(getAccessToken())
      if (!token) throw new Error('WALLET_SIGN_IN_REQUIRED: Please sign in again to finish wallet setup.')
      await bindWallet(wallet, token)
      await qc.invalidateQueries({ queryKey: ['session'] })
      await qc.invalidateQueries({ queryKey: ['wallet-balance'] })
      return wallet
    },
  })
  const [waitExpired, setWaitExpired] = useState(false)
  useEffect(() => {
    if (!session?.userId || session.wallet) return
    const timer = setTimeout(() => setWaitExpired(true), 30_000)
    return () => clearTimeout(timer)
  }, [session?.userId, session?.wallet])
  if (!session?.userId || session.wallet || pathname === '/login') return null
  const needsLogin = isInitialized && !isSignedIn
  return (
    <div role="status" className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl rounded-xl border bg-background p-4 shadow-lg">
      <p className="text-sm">{needsLogin ? 'WALLET_SIGN_IN_REQUIRED: Sign in again to finish wallet setup.' : recovery.error?.message ?? (waitExpired ? 'WALLET_SETUP_PENDING: Wallet setup is taking longer than expected.' : 'Setting up your wallet...')}</p>
      <div className="mt-2 flex gap-4 text-sm">
        {isSignedIn && <button className="cursor-pointer underline disabled:opacity-50" disabled={recovery.isFetching} onClick={() => void recovery.refetch()}>Retry wallet setup</button>}
        <a className="underline" href="/login?from=%2Fdashboard">Sign in again</a>
      </div>
    </div>
  )
}
