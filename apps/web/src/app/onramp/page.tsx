'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

type TestOrder = { paymentLink: string; receipt: string; orderId: string; wallet: string; paymentTotal?: string; purchaseAmount?: string }

export default function OnrampReviewPage() {
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<TestOrder | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const {data:session,isLoading:sessionLoading,isError:sessionError}=useQuery({queryKey:['session'],queryFn:async()=>{
    const response=await fetch('/api/auth/session',{cache:'no-store'})
    if(response.status===401)return null
    if(!response.ok)throw new Error('Unable to check sign-in status')
    return (await response.json()).data
  }})

  async function request(action: 'create' | 'status') {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/wallet/onramp/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'create' ? { action, acceptSandbox: true } : { action, receipt: order?.receipt }), signal: AbortSignal.timeout(30_000) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Sandbox unavailable')
      if (action === 'create') { setOrder(body); setStatus('Sandbox order created. Loading Coinbase checkout below…') }
      else setStatus(body.status === 'ONRAMP_ORDER_STATUS_COMPLETED' ? 'Sandbox completed. No card was charged and no USDC was deposited.' : `Coinbase order status: ${body.status}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed') }
    finally { setBusy(false) }
  }

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== 'https://pay.coinbase.com' || !frame.current || event.source !== frame.current.contentWindow) return
      let data = event.data
      if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return } }
      if (typeof data?.eventName !== 'string' || !data.eventName.startsWith('onramp_api.')) return
      // Coinbase can fall back to QR or its sandbox button on browsers without native Apple Pay.
      if (data.data?.errorCode === 'ERROR_CODE_GUEST_APPLE_PAY_NOT_SUPPORTED') return
      if (data.eventName === 'onramp_api.load_success') { setError(''); setStatus('Coinbase checkout is ready. Complete the simulated payment below, then check order status.') }
      else if (data.eventName.endsWith('error')) setError('Coinbase could not complete this sandbox step. Check domain setup or refresh order status.')
      else if (data.eventName === 'onramp_api.cancel') setStatus('Payment window closed. You can check this test order before starting another.')
      else if (data.eventName === 'onramp_api.polling_success') setStatus('Sandbox payment reported complete. Click Check order status to verify with the server.')
      else if (data.eventName === 'onramp_api.commit_success') setStatus('Simulated payment submitted. Check order status for the result.')
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  return <main className="mx-auto max-w-xl space-y-5 px-5 py-12">
    <Link href="/" className="text-sm text-primary">← AgentJob</Link>
    <h1 className="text-2xl font-semibold">Try Coinbase checkout</h1>
    <p className="text-sm text-muted-foreground">Sign in, then open checkout below. No wallet funding is needed.</p>
    <div className="rounded-xl border border-border bg-secondary p-4 text-sm"><strong>Sandbox · USD 5 → USDC on Base</strong><p className="mt-1">No real charge or USDC deposit. Do not enter real card details.</p></div>
    {sessionLoading?<p role="status" className="text-sm">Checking sign-in status…</p>:!session?.userId?<Link href="/login?from=%2Fonramp" className="block rounded-xl bg-primary p-3 text-center text-primary-foreground">Sign in to try checkout</Link>:!session.wallet?<p role="alert" className="text-sm text-destructive">Wallet setup is incomplete. Finish setting up your account before opening checkout.</p>:null}
    {sessionError&&<p role="alert" className="text-sm text-destructive">Unable to check your session. Refresh this page and try again.</p>}
    {session?.userId&&!order&&<><p className="text-xs text-muted-foreground">By opening checkout, you acknowledge this is a simulation using synthetic test contact details and agree to Coinbase’s <a className="underline" href="https://www.coinbase.com/legal/guest-checkout/us" target="_blank" rel="noreferrer">Guest Checkout Terms</a>, <a className="underline" href="https://www.coinbase.com/legal/user_agreement/united_states" target="_blank" rel="noreferrer">User Agreement</a> and <a className="underline" href="https://www.coinbase.com/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
    <button disabled={!session.wallet || busy} onClick={() => void request('create')} className="w-full rounded-xl bg-primary p-3 text-primary-foreground disabled:opacity-50">{busy ? 'Opening Coinbase checkout…' : 'Open Coinbase checkout — Sandbox'}</button></>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status && <p role="status" className="text-sm">{status}</p>}
    {order && <section className="space-y-3">
      <h2 className="font-semibold">Coinbase checkout · Sandbox</h2>
      <iframe ref={frame} src={order.paymentLink} title="Coinbase sandbox payment" allow="payment" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" className="h-96 w-full rounded-xl border border-border" />
      <p className="text-xs text-muted-foreground">If checkout does not appear, check your browser’s privacy or content-blocking settings. Do not enter real card details. An expired checkout requires a new sandbox session.</p>
      <button disabled={busy} onClick={() => void request('status')} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">Check order status</button>
      <button disabled={busy} onClick={()=>{setOrder(null);setStatus('');setError('')}} className="ml-3 text-sm underline">Start a new sandbox session</button>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Review details</summary><p className="mt-2 break-all">Headless Onramp · Server-generated payment link<br/>Destination: {order.wallet}<br/>Test order: {order.orderId}<br/>Quoted total: {order.paymentTotal ?? 'See Coinbase'} USD · Receive: {order.purchaseAmount ?? 'See Coinbase'} USDC (simulated)</p></details>
    </section>}
  </main>
}
