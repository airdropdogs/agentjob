'use client'
import { useQuery } from '@tanstack/react-query'
import { CAPABILITIES, type Capability } from '@/lib/verification-policy'
export function VerifiedCapabilities({walletAddress}:{walletAddress:string}) {
  const {data}=useQuery({queryKey:['verification',walletAddress],queryFn:async()=>{
    const response=await fetch(`/api/agents/${walletAddress}/verification`);if(!response.ok)throw new Error('Unable to load verification');return response.json()
  }})
  if(!data?.enabled)return null
  const valid=data.results.filter((r:any)=>r.valid)
  return <section className="mt-4 border-t pt-4 text-sm"><h3 className="font-medium" title="Passed specific platform tests. This does not guarantee every response or verify the underlying model identity.">Verified capabilities ⓘ</h3>
    <div className="mt-2 flex flex-wrap gap-2">{valid.length?valid.map((r:any)=><span key={r.capability} className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600">✓ {CAPABILITIES[r.capability as Capability]}</span>):<span className="text-muted-foreground">{data.results.length?'No currently verified capabilities':'Not tested yet'}</span>}</div>
    {data.runtime&&<div className="mt-3 space-y-1 text-xs text-muted-foreground"><p>Framework: {data.runtime.framework}</p><p>Model: {data.runtime.model}</p><p>Source: {({connector:'Connector report',provider:'Provider profile',agent:'Agent self-report',admin:'Admin entry',unknown:'Unknown'} as Record<string,string>)[data.runtime.source]??'Unknown'} (declared, not identity-verified)</p></div>}
    {!!data.results.length&&<details className="mt-2 text-xs text-muted-foreground"><summary>View test results</summary>{data.results.map((r:any)=><p className="mt-2" key={r.capability}>{CAPABILITIES[r.capability as Capability]} · {r.valid ? (r.status === 'passed' ? 'Passed' : 'Previous pass remains valid; latest test: ' + r.status.replaceAll('_', ' ')) : r.status==='passed'?'Expired':r.status.replaceAll('_',' ')}{r.valid && r.effective_valid_until ? ` (valid until ${new Date(r.effective_valid_until).toLocaleDateString()})` : ''}{r.completed_at?` · ${new Date(r.completed_at).toLocaleDateString()}`:''} · Suite {r.suite_version}</p>)}</details>}
  </section>
}
