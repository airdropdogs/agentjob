'use client'

import { useState } from 'react'

export function CoinbaseCheckout() {
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [url,setUrl] = useState('')
  async function openCheckout() {
    setBusy(true);setError('');setUrl('')
    try {
      const response = await fetch('/api/wallet/onramp/session', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acceptLive:true}),signal:AbortSignal.timeout(30_000) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Checkout unavailable.')
      const checkout = new URL(data.url)
      if (checkout.origin !== 'https://pay.coinbase.com' || !checkout.searchParams.get('sessionToken')) throw new Error('Invalid checkout link.')
      setUrl(checkout.toString())
      window.location.assign(checkout.toString())
    } catch(e) {setError(e instanceof Error ? e.message : 'Checkout unavailable.')} finally {setBusy(false)}
  }
  return <section className="space-y-3 text-sm">
    <div className="rounded-lg bg-secondary p-3"><strong>Pay with Coinbase · USDC on Base</strong><p className="mt-1 text-xs text-muted-foreground">Requested amount: USD 0.0001. Coinbase may reject this amount due to minimums or currency precision. We do not automatically increase it. Eligibility, fees and the final amount are confirmed by Coinbase. This is a real purchase.</p></div>
    <p className="text-xs text-muted-foreground">Limited access: Coinbase has advised up to 25 transactions per project, at most USD 5 each. Remaining allowance is not shown here. Do not confirm a total above USD 5; if the minimum is higher, stop and contact support.</p>
    <p className="text-xs text-muted-foreground">By continuing, you agree to Coinbase’s <a href="https://www.coinbase.com/legal/user_agreement" target="_blank" rel="noreferrer" className="underline">User Agreement</a> and <a href="https://www.coinbase.com/legal/privacy" target="_blank" rel="noreferrer" className="underline">Privacy Policy</a>. You review and confirm payment on Coinbase. Opening checkout does not charge you.</p>
    <button type="button" disabled={busy} onClick={()=>void openCheckout()} className="w-full rounded-xl bg-primary p-3 text-primary-foreground disabled:opacity-50">{busy?'Opening Coinbase…':'Continue to Coinbase · USD 0.0001'}</button>
    {url&&<a href={url} rel="noreferrer" className="block text-center underline">Continue to the checkout just created</a>}
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">After purchasing, return to your wallet and refresh the USDC balance. Returning from Coinbase does not by itself confirm a deposit.</p>
  </section>
}
