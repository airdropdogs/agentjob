'use client'

import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'

export function CoinbaseCheckout() {
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [url,setUrl] = useState('')
  const [diagnostics,setDiagnostics] = useState('')
  const [checking,setChecking] = useState(false)
  const [copyNotice,setCopyNotice] = useState('')
  async function checkConnection() {
    setChecking(true);setCopyNotice('')
    try {
      const response=await fetch('/api/wallet/onramp/network-check',{cache:'no-store',signal:AbortSignal.timeout(15_000)})
      const report=await response.json()
      if(!response.ok)throw new Error(report.error||'Diagnostics unavailable.')
      let lastCheckout=null
      try {lastCheckout=JSON.parse(sessionStorage.getItem('onramp-network-report')||'null')} catch {}
      setDiagnostics(JSON.stringify({...report,lastCheckoutInThisTab:lastCheckout},null,2))
    } catch(e) {setDiagnostics(JSON.stringify({error:e instanceof Error?e.message:'Diagnostics unavailable.'},null,2))}
    finally {setChecking(false)}
  }
  useEffect(() => {
    function restore(event: PageTransitionEvent) {
      if (event.persisted) { setBusy(false); setUrl('') }
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [])
  async function openCheckout() {
    setBusy(true);setError('');setUrl('')
    try {
      const response = await fetch('/api/wallet/onramp/session', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acceptLive:true}),signal:AbortSignal.timeout(30_000) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Checkout unavailable.')
      const checkout = new URL(data.url)
      if (checkout.origin !== 'https://pay.coinbase.com' || !checkout.searchParams.get('sessionToken')) throw new Error('Invalid checkout link.')
      setUrl(checkout.toString())
      // Only a fixed, non-identifying network report; never persist the URL/token.
      try {sessionStorage.setItem('onramp-network-report',JSON.stringify(data.network??null))} catch {}
      window.location.assign(checkout.toString())
    } catch(e) {setError(e instanceof Error ? e.message : 'Checkout unavailable.');setBusy(false)}
  }
  return <section className="space-y-3 text-sm">
    <div className="rounded-lg bg-secondary p-3"><strong>Pay with Coinbase · USDC on Base</strong><p className="mt-1 text-xs text-muted-foreground">Requested amount: USD 0.0001. Coinbase may reject this amount due to minimums or currency precision. We do not automatically increase it. Eligibility, fees and the final amount are confirmed by Coinbase. This is a real purchase.</p></div>
    <p className="text-xs text-muted-foreground">Limited access: Coinbase has advised up to 25 transactions per project, at most USD 5 each. Remaining allowance is not shown here. Do not confirm a total above USD 5; if the minimum is higher, stop and contact support.</p>
    <p className="text-xs text-muted-foreground">By continuing, you agree to Coinbase’s <a href="https://www.coinbase.com/legal/user_agreement" target="_blank" rel="noreferrer" className="underline">User Agreement</a> and <a href="https://www.coinbase.com/legal/privacy" target="_blank" rel="noreferrer" className="underline">Privacy Policy</a>. You review and confirm payment on Coinbase. Opening checkout does not charge you.</p>
    <button type="button" disabled={busy} aria-busy={busy} onClick={()=>void openCheckout()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary p-3 text-primary-foreground disabled:cursor-wait disabled:opacity-80">{busy&&<Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none"/>}{busy?(url?'Redirecting to Coinbase…':'Preparing secure checkout…'):'Continue to Coinbase · USD 0.0001'}</button>
    {busy&&<div role="status" aria-live="polite" className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3"><ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary"/><div><p className="font-medium">{url?'Opening Coinbase checkout':'Connecting securely to Coinbase'}</p><p className="mt-1 text-xs text-muted-foreground">{url?'You are being redirected to pay.coinbase.com. Please keep this window open.':'Please wait while we prepare your checkout. No payment has been made.'}</p></div></div>}
    {url&&<a href={url} rel="noreferrer" className="block text-center underline">Continue to the checkout just created</a>}
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Connection diagnostics</summary><p className="mt-2">Check region detection without opening checkout. The report excludes IP addresses, email, wallet and session tokens. A previous checkout report, if present, is from this browser tab only.</p><button type="button" disabled={checking||busy} onClick={()=>void checkConnection()} className="my-2 underline disabled:opacity-50">{checking?'Checking…':'Check connection (no payment)'}</button>{diagnostics&&<><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary p-3">{diagnostics}</pre><button type="button" className="mt-2 underline" onClick={async()=>{try{await navigator.clipboard.writeText(diagnostics);setCopyNotice('Report copied')}catch{setCopyNotice('Select and copy the report above.')}}}>Copy diagnostics</button><span role="status" className="ml-2">{copyNotice}</span></>}</details>
    <p className="text-xs text-muted-foreground">After purchasing, return to your wallet and refresh the USDC balance. Returning from Coinbase does not by itself confirm a deposit.</p>
  </section>
}

