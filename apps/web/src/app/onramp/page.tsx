'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

type TestOrder = { paymentLink: string; receipt: string; orderId: string; wallet: string; paymentTotal?: string; purchaseAmount?: string }

export default function OnrampReviewPage() {
  const [accepted, setAccepted] = useState(false)
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
        body: JSON.stringify(action === 'create' ? { action, acceptSandbox: accepted } : { action, receipt: order?.receipt }), signal: AbortSignal.timeout(30_000) })
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
    <h1 className="text-2xl font-semibold">Coinbase Onramp · Sandbox</h1>
    <p className="text-sm text-muted-foreground">Coinbase Onramp review environment. Sign in with your own email, then test a simulated USD 5 purchase of USDC on Base into your AgentJob wallet.</p>
    <div className="rounded-xl border border-border bg-secondary p-4 text-sm">Test only: no real card charge, USDC transfer or chat payment. Do not enter real card details. Production access is not enabled. Live Headless Onramp is limited to eligible US users.</div>
    <ol className="list-inside list-decimal space-y-2 rounded-xl border p-4 text-sm"><li>Sign in to AgentJob using your own email.</li><li>Confirm sandbox mode and click Buy USDC — Sandbox.</li><li>Complete the simulated Coinbase payment below, then click Check order status.</li></ol>
    {sessionLoading?<p role="status" className="text-sm">Checking sign-in status…</p>:session?.userId?<p className="break-all rounded-xl border p-3 text-sm">Signed in as {session.email}<br/>Destination wallet: {session.wallet || 'Wallet setup incomplete'}</p>:<Link href="/login?from=%2Fonramp" className="inline-block rounded-xl border px-4 py-3 text-primary">Sign in / create a test account</Link>}
    {sessionError&&<p role="alert" className="text-sm text-destructive">Unable to check your session. Refresh this page and try again.</p>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1" />I understand this uses Coinbase sandbox orders with synthetic test contact information and does not fund my wallet.</label>
    <p className="text-xs text-muted-foreground">Review Coinbase’s <a className="underline" href="https://www.coinbase.com/legal/guest-checkout/us" target="_blank" rel="noreferrer">Guest Checkout Terms</a>, <a className="underline" href="https://www.coinbase.com/legal/user_agreement/united_states" target="_blank" rel="noreferrer">User Agreement</a> and <a className="underline" href="https://www.coinbase.com/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>. Real purchases require a separate production implementation and user verification.</p>
    <button disabled={!session?.wallet || !accepted || busy || !!order} onClick={() => void request('create')} className="w-full rounded-xl bg-primary p-3 text-primary-foreground disabled:opacity-50">{busy ? 'Please wait…' : 'Buy USDC — Sandbox'}</button>
    <p className="text-xs text-muted-foreground">This button creates a sandbox order on our server and loads the Coinbase-hosted checkout from pay.coinbase.com below. It does not open wallet-transfer instructions.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status && <p role="status" className="text-sm">{status}</p>}
    {order && <section className="space-y-3">
      <p className="break-all text-xs text-muted-foreground">Destination: {order.wallet}<br />Test order: {order.orderId}<br />Quoted total: {order.paymentTotal ?? 'See Coinbase'} USD · Receive: {order.purchaseAmount ?? 'See Coinbase'} USDC (simulated)</p>
      <iframe ref={frame} src={order.paymentLink} title="Coinbase sandbox payment" allow="payment" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" className="h-96 w-full rounded-xl border border-border" />
      <p className="text-xs text-muted-foreground">If checkout does not appear, check your browser’s privacy or content-blocking settings. Do not enter real card details. An expired checkout requires a new sandbox session.</p>
      <button disabled={busy} onClick={() => void request('status')} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">Check order status</button>
      <button disabled={busy} onClick={()=>{setOrder(null);setStatus('');setError('')}} className="ml-3 text-sm underline">Start a new sandbox session</button>
    </section>}
    <p className="text-xs text-muted-foreground">This isolated review page does not change the existing wallet-transfer funding flow, free messages, payment limits or withdrawals.</p>
  </main>
}
