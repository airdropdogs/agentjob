'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CAPABILITIES, type Capability } from '@/lib/verification-policy'

export function VerificationPanel() {
  const cache = useQueryClient()
  const [agentIds,setAgents] = useState<string[]>([]), [capabilities,setCapabilities] = useState<Capability[]>(Object.keys(CAPABILITIES) as Capability[])
  const [search,setSearch] = useState(''), [multiple,setMultiple] = useState(false)
  const [onlineOnly,setOnlineOnly] = useState(true)
  const [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const [settingsNotice,setSettingsNotice] = useState('')
  const [requestKey,setRequestKey] = useState<string | null>(null)
  const {data,isLoading} = useQuery({queryKey:['admin-verification'],queryFn:async()=>{
    const res=await fetch('/api/admin/verification'); if(!res.ok) throw new Error('Unable to load tests'); return res.json()
  },refetchInterval:5000})
  async function action(body:unknown) {
    const savingSettings=(body as {action?:string}).action==='settings'
    if(savingSettings)setSettingsNotice('Saving limits...')
    setBusy(true);setError('')
    try { const res=await fetch('/api/admin/verification',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const result=await res.json();if(!res.ok)throw new Error(result.error); await cache.invalidateQueries({queryKey:['admin-verification']});setRequestKey(null);if(savingSettings)setSettingsNotice('Limits saved.')
    } catch(e) {setError(e instanceof Error ? e.message : 'Request failed');if(savingSettings)setSettingsNotice(e instanceof Error ? e.message : 'Unable to save limits.')} finally{setBusy(false)}
  }
  if(isLoading)return <p>Loading tests...</p>
  if(!data?.enabled)return <p className="text-sm text-muted-foreground">Capability testing is disabled. Enable AGENT_VERIFICATION_ENABLED after applying the verification migrations.</p>
  const selected=data.agents.filter((a:any)=>agentIds.includes(a.id))
  const online=(a:any)=>a.last_heartbeat_at && Date.now()-new Date(a.last_heartbeat_at).getTime()<120000
  const matching=data.agents.filter((a:any)=>(!onlineOnly||online(a))&&[a.name,a.wallet,a.id].some(v=>String(v??'').toLowerCase().includes(search.trim().toLowerCase())))
  const groups = [
    {id:'pending',label:'Needs review',color:'text-amber-700 dark:text-amber-400'},
    {id:'active',label:'In progress',color:'text-blue-700 dark:text-blue-400'},
    {id:'reviewed',label:'Reviewed results',color:'text-emerald-700 dark:text-emerald-400'},
    {id:'other',label:'Runtime inquiries and other results',color:'text-muted-foreground'},
  ]
  const groupFor=(r:any)=>['queued','running','evaluating'].includes(r.status)?'active':r.capability==='runtime_info'?'other':['review_required','error'].includes(r.status)?'pending':['passed','failed','revoked'].includes(r.status)?'reviewed':'other'
  const statusColor=(status:string)=>status==='passed'?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400':['failed','error','revoked'].includes(status)?'bg-red-500/10 text-red-700 dark:text-red-400':status==='review_required'?'bg-amber-500/10 text-amber-700 dark:text-amber-400':'bg-secondary text-muted-foreground'
  const total=selected.length*capabilities.length
  const overLimit=capabilities.length>data.settings.agentDailyLimit || selected.some((a:any)=>(a.daily_used??0)+capabilities.length>data.settings.agentDailyLimit) || (data.dailyUsed??0)+total>data.settings.dailyLimit
  return <section className="space-y-5">
    <div><h2 className="text-lg font-semibold">Capability verification</h2><p className="text-sm text-muted-foreground">Unannounced checks use the normal connector. No customer payment, free allowance or revenue is recorded. Provider model costs still apply.</p></div>
    {!data.evaluatorReady&&<p className="rounded-lg bg-secondary p-3 text-sm">Evidence collection mode: no evaluator API is required. Completed tests wait for review here or with your AI assistant; capabilities are not automatically certified.</p>}
    {error&&<p role="alert" className="text-red-500">{error}</p>}
    <fieldset className="space-y-3 rounded-xl border p-3"><legend className="px-1 text-sm font-medium">Agents</legend>
      <input aria-label="Search Agents" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, wallet or Agent ID" className="w-full rounded-lg border bg-background p-2 text-sm"/>
      <div className="flex flex-wrap gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={multiple} disabled={busy} onChange={e=>{setMultiple(e.target.checked);if(!e.target.checked)setAgents(ids=>ids.slice(0,1));setRequestKey(null)}}/>Select multiple Agents</label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={onlineOnly} disabled={busy} onChange={e=>{setOnlineOnly(e.target.checked);if(e.target.checked)setAgents(ids=>ids.filter(id=>data.agents.some((a:any)=>a.id===id&&online(a))));setRequestKey(null)}}/>Online only</label>
        {multiple&&<button disabled={busy} className="underline" onClick={()=>{setAgents(matching.filter(online).slice(0,20).map((a:any)=>a.id));setRequestKey(null)}}>Select matching online (up to 20)</button>}
        {!!agentIds.length&&<button disabled={busy} className="underline" onClick={()=>{setAgents([]);setRequestKey(null)}}>Clear selection ({agentIds.length})</button>}
      </div>
      <div className="max-h-52 space-y-1 overflow-y-auto">{matching.length?matching.map((a:any)=><label key={a.id} className="flex items-center gap-2 rounded-lg p-2 text-sm hover:bg-secondary">
        <input type={multiple?'checkbox':'radio'} name="verification-agent" checked={agentIds.includes(a.id)} disabled={busy||(!online(a)&&!agentIds.includes(a.id))||(!agentIds.includes(a.id)&&multiple&&agentIds.length>=20)} onChange={()=>{setAgents(ids=>multiple?(ids.includes(a.id)?ids.filter(id=>id!==a.id):[...ids,a.id]):[a.id]);setRequestKey(null)}}/>
        <span className="min-w-0 flex-1"><span className="block truncate">{a.name}</span>{a.wallet&&<span className="block truncate text-xs text-muted-foreground">{a.wallet}</span>}</span><span className="text-xs text-muted-foreground">{online(a)?'Online':'Offline'} · {Math.max(0,data.settings.agentDailyLimit-(a.daily_used??0))} tests left</span>
      </label>):<p className="text-sm text-muted-foreground">No matching Agents.</p>}</div>
    </fieldset>
    <fieldset className="space-y-3 rounded-xl border p-3"><legend className="px-1 text-sm font-medium">Capabilities</legend>
      <div className="flex flex-wrap gap-4">{Object.entries(CAPABILITIES).map(([id,label])=><label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={capabilities.includes(id as Capability)} disabled={busy} onChange={()=>{setCapabilities(c=>c.includes(id as Capability)?c.filter(v=>v!==id):[...c,id as Capability]);setRequestKey(null)}}/>{label}</label>)}</div>
      <button disabled={busy} className="text-sm underline" onClick={()=>{setCapabilities(Object.keys(CAPABILITIES) as Capability[]);setRequestKey(null)}}>Select all four</button>
    </fieldset>
    {selected.filter((a:any)=>!a.agreement_at).map((a:any)=><label key={a.id} className="flex gap-2 text-sm"><input type="checkbox" checked={false} disabled={busy} onChange={()=>void action({action:'agreement',agentId:a.id})}/>I confirm {a.name} has accepted standing limited testing terms, including model costs. Record agreement once.</label>)}
    <p className="text-sm text-muted-foreground">{selected.length} Agent(s) × {capabilities.length} capabilities = {total} tests. Platform slots left today: {Math.max(0,data.settings.dailyLimit-(data.dailyUsed??0))}. Each capability uses one daily test slot. Tests run sequentially per Agent; queued tests survive closing this page.</p>
    {overLimit&&<p role="alert" className="text-amber-600">This selection exceeds Test limits. Four capabilities need at least four available tests per Agent. Adjust the limits below or select fewer capabilities.</p>}
    <button disabled={busy||!total||overLimit||selected.some((a:any)=>!a.agreement_at||!online(a))} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" onClick={()=>{const key=requestKey??crypto.randomUUID();setRequestKey(key);void action({action:'start-batch',agentIds,capabilities,requestKey:key})}}>{busy?'Submitting...':`Run selected tests (${total})`}</button>
    <details className="rounded-xl border p-3"><summary>Test limits (UTC day)</summary><form className="mt-3 flex flex-wrap gap-3" key={JSON.stringify(data.settings)} onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void action({action:'settings',settings:Object.fromEntries(Object.keys(data.settings).map(k=>[k,Number(form.get(k))]))})}}>
      {Object.entries({dailyLimit:'Platform tests/day',agentDailyLimit:'Agent tests/day',maxConcurrent:'Concurrent tests',timeoutMinutes:'Timeout minutes',validDays:'Valid days',evidenceRetentionDays:'Source retention days'}).map(([key,label])=><label key={key} className="text-xs">{label}<input className="block w-24 rounded border bg-background p-2" name={key} type="number" min={key==='timeoutMinutes'?2:1} max={({dailyLimit:10000,agentDailyLimit:1000,maxConcurrent:10,timeoutMinutes:30,validDays:90,evidenceRetentionDays:30} as Record<string,number>)[key]} required defaultValue={data.settings[key]}/></label>)}
      <button disabled={busy} className="rounded border px-3">Save limits</button></form>{settingsNotice&&<p role="status" className="mt-2 text-sm">{settingsNotice}</p>}</details>
    <section className="space-y-3"><h3 className="font-medium">Runtime information</h3><p className="text-xs text-muted-foreground">Use Ask Agent to collect a declaration through chat (one test slot). New replies automatically fill the form for your review. Connector reports or existing details provide fallback values. Unknown is allowed. Saving publishes the declaration, not a verified model identity.</p>{data.agents.filter((a:any)=>agentIds.length?agentIds.includes(a.id):data.runs.some((r:any)=>r.agent_id===a.id)).map((a:any)=><RuntimeInfoForm key={a.id+JSON.stringify(a.runtime)} agent={a} busy={busy} save={action}/>)}</section>
    <div className="space-y-5"><div><h3 className="font-medium">Test results</h3><p className="text-xs text-muted-foreground">Latest 100 tests across all Agents, including offline Agents. Passed and failed results may be assessed automatically or by an administrator.</p></div>{data.runs.length===0?<p className="text-muted-foreground">No tests yet.</p>:groups.map(group=>{const runs=data.runs.filter((r:any)=>groupFor(r)===group.id);return <section key={group.id} className="space-y-3" aria-label={group.label}><h4 className={`font-medium ${group.color}`}>{group.label} ({runs.length})</h4>{!runs.length?<p className="text-sm text-muted-foreground">No results in this group.</p>:runs.map((r:any)=><article key={r.id} className="rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><strong>{r.name} · {r.capability==='runtime_info'?'Runtime inquiry':CAPABILITIES[r.capability as Capability]}</strong><span className={`rounded-full px-2 py-1 text-xs font-medium ${statusColor(r.status)}`}>{r.status.replaceAll('_',' ')}</span></div>
      <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()} · Suite {r.suite_version}</p>
      {r.result?.reason&&<p className="mt-2">{r.result.reason}</p>}
      <details className="mt-2"><summary>Test evidence and review</summary><pre className="overflow-auto whitespace-pre-wrap py-2 text-xs">{JSON.stringify({challenge:r.challenge,result:r.result,evaluator:r.evaluator_model},null,2)}</pre>
        <EvidencePreview id={r.id} />
      </details>
        {r.capability!=='runtime_info'&&['review_required','passed','failed','error'].includes(r.status)&&<form className="mt-3 flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action({action:'review',id:r.id,verdict:f.get('verdict'),reason:f.get('reason')})}}><input name="reason" aria-label="Review reason" defaultValue="Manual review of the test reply and available file evidence." required minLength={10} maxLength={1000} placeholder="Review evidence and explain decision" className="min-w-60 rounded border bg-background p-2"/><select name="verdict" aria-label="Review decision" defaultValue={r.status==='review_required'||r.status==='passed'?'passed':'failed'} className="rounded border bg-background p-2"><option value="revoked">Revoke</option><option value="failed">Fail</option><option value="passed">Pass after manual review</option></select><button disabled={busy} className="rounded border px-3">Save review</button></form>}
      {['queued','running','evaluating'].includes(r.status)&&<button disabled={busy} onClick={()=>void action({action:'cancel',id:r.id})} className="mt-2 underline">Cancel test</button>}
    </article>)}</section>})}</div>
  </section>
}

function EvidencePreview({id}:{id:string}) {
  const [open,setOpen]=useState(false)
  const {data,isLoading,isError}=useQuery({queryKey:['verification-evidence',id],enabled:open,queryFn:async()=>{
    const r=await fetch(`/api/admin/verification/${id}/evidence`);if(!r.ok)throw new Error('Evidence unavailable');return r.json()
  }})
  return <div><button className="underline" onClick={()=>setOpen(v=>!v)}>{open?'Hide evidence':'Open reply and file evidence'}</button>
    {open&&<div className="mt-2 space-y-2">{isLoading?<p>Loading evidence...</p>:isError?<p>Evidence unavailable. It may have expired.</p>:<>
      <p className="whitespace-pre-wrap">{data?.response_text || 'No text reply.'}</p>
      <div className="flex flex-wrap gap-3">{data?.files?.map((file:any)=><figure key={file.url}><img src={file.url} alt={file.name} className="max-h-64 max-w-full rounded-lg border"/><figcaption className="text-xs">{file.name}</figcaption></figure>)}</div>
      {!data?.files?.length&&<p className="text-xs text-muted-foreground">No available file evidence.</p>}
    </>}</div>}
  </div>
}

function RuntimeInfoForm({agent,busy,save}:{agent:any;busy:boolean;save:(body:unknown)=>Promise<void>}) {
  const freshReply=agent.runtime?.draft?.source==='agent'&&new Date(agent.runtime.draft.collectedAt??0).getTime()>new Date(agent.runtime?.approvedAt??0).getTime()
  const initial=(freshReply?agent.runtime.draft:agent.runtime?.approved??agent.runtime?.draft)??{framework:'Unknown',model:'Unknown',source:'unknown'}
  const [framework,setFramework]=useState(initial.framework),[model,setModel]=useState(initial.model)
  const source=framework===agent.runtime?.draft?.framework&&model===agent.runtime?.draft?.model?agent.runtime.draft.source:framework===initial.framework&&model===initial.model?initial.source:'admin'
  const sources:Record<string,string>={connector:'Connector report',provider:'Provider profile',agent:'Agent self-report',admin:'Admin entry',unknown:'Unknown'}
  return <form className="flex flex-wrap items-end gap-3 rounded-xl border p-3" onSubmit={async e=>{e.preventDefault();await save({action:'runtime-info',agentId:agent.id,info:{framework,model}})}}>
    <strong className="w-full text-sm">{agent.name}</strong>
    <label className="text-xs">Framework (no version)<input aria-label="Framework" value={framework} onChange={e=>setFramework(e.target.value)} maxLength={100} placeholder="Unknown" className="block rounded border bg-background p-2"/></label>
    <label className="text-xs">Model (include version if known)<input aria-label="Model" value={model} onChange={e=>setModel(e.target.value)} maxLength={200} placeholder="Unknown" className="block rounded border bg-background p-2"/></label>
    <span className="text-xs">Source: {sources[source]??'Unknown'}</span>
    {agent.runtime?.approved&&agent.runtime?.draft&&JSON.stringify(agent.runtime.approved)!==JSON.stringify(agent.runtime.draft)&&<button type="button" disabled={busy} className="text-xs underline" onClick={()=>{setFramework(agent.runtime.draft.framework);setModel(agent.runtime.draft.model)}}>Use latest report</button>}
    <button type="button" disabled={busy} className="rounded border px-3 py-2 text-sm" onClick={()=>void save({action:'ask-runtime',agentId:agent.id,requestKey:crypto.randomUUID()})}>Ask Agent</button>
    <button disabled={busy} className="rounded border px-3 py-2 text-sm">Save information</button>
    {agent.runtime?.approvedAt&&<span className="text-xs text-muted-foreground">Last saved: {new Date(agent.runtime.approvedAt).toLocaleString()}</span>}
  </form>
}
