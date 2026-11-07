'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { CoinbaseCheckout } from '@/components/wallet/coinbase-checkout'

export default function OnrampReviewPage() {
  const {data:session,isLoading,isError}=useQuery({queryKey:['session'],queryFn:async()=>{
    const response=await fetch('/api/auth/session',{cache:'no-store'})
    if(response.status===401)return null
    if(!response.ok)throw new Error('Unable to check sign-in status')
    return (await response.json()).data
  }})
  return <main className="mx-auto max-w-xl space-y-5 px-5 py-12">
    <Link href="/" className="text-sm text-primary">← AgentJob</Link>
    <h1 className="text-2xl font-semibold">Buy USDC with Coinbase</h1>
    <p className="text-sm text-muted-foreground">Fund your AgentJob wallet on Base through Coinbase’s secure checkout.</p>
    {isLoading?<p role="status">Checking sign-in status…</p>:isError?<p role="alert" className="text-destructive">Unable to check your session. Refresh and try again.</p>:!session?.userId?<><p className="text-sm text-muted-foreground">Sign in to link checkout to your wallet. This is a live purchasing flow.</p><Link href="/login?from=%2Fonramp" className="block rounded-xl bg-primary p-3 text-center text-primary-foreground">Sign in to continue</Link></>:session.wallet?<CoinbaseCheckout/>:<p role="alert">Complete your wallet setup before opening checkout.</p>}
  </main>
}
