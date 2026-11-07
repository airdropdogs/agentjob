'use client'

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { installCdpProxy } from '@/lib/cdp-proxy-client'
import { getAccessToken } from '@coinbase/cdp-core'
import { CDPHooksProvider, useCreateEvmSmartAccount, useEvmSmartAccounts, useIsSignedIn } from '@coinbase/cdp-hooks'

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

/**
 * After login, watches CDP smart accounts and syncs wallet to DB/session when missing.
 * createEvmSmartAccount() may be needed before evmSmartAccounts is populated.
 */
function WalletSyncer() {
  const { isSignedIn } = useIsSignedIn()
  const { evmSmartAccounts } = useEvmSmartAccounts()
  const { createEvmSmartAccount } = useCreateEvmSmartAccount()
  const qc = useQueryClient()
  const [synced, setSynced] = useState(false)

  const { data: session, isFetched: sessionFetched } = useQuery<{
    userId?: string; wallet?: string
  } | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  useEffect(() => {
    // CDP signed in, session loaded, userId present, no wallet yet, not yet synced
    if (!isSignedIn) return
    if (!sessionFetched) return
    if (!session?.userId) return
    if (session.wallet) return
    if (synced) return

    setSynced(true)

    const run = async () => {
      // Use existing smart account or create one
      let walletAddr: string | undefined = evmSmartAccounts?.[0]?.address
      if (!walletAddr) {
        try {
          walletAddr = await createEvmSmartAccount()
          console.log('[WalletSyncer] created smart account:', walletAddr)
        } catch (e) {
          console.warn('[WalletSyncer] createEvmSmartAccount failed:', e)
          setSynced(false)
          return
        }
      }

      try {
        const accessToken = await getAccessToken()
        if (!accessToken) throw new Error('Please sign in again')
        const r = await fetch('/api/auth/session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ wallet: walletAddr }),
        })
        const json = await r.json()
        if (json.data?.updated) {
          console.log('[WalletSyncer] wallet synced to DB:', walletAddr)
          qc.invalidateQueries({ queryKey: ['session'] })
        }
      } catch (e) {
        console.warn('[WalletSyncer] sync failed:', e)
        setSynced(false)
      }
    }

    run()
  }, [isSignedIn, sessionFetched, session, evmSmartAccounts, createEvmSmartAccount, synced, qc])

  return null
}
