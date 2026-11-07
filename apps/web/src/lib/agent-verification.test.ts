import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { Pool } from 'pg'
import { NextRequest } from 'next/server'
import * as db from './db'
import * as policy from './verification-policy'
import * as runtime from './agent-runtime-info'
import * as fixture from './verification-fixture'
import { matchesFileHeader } from './attachment-policy'

function load(file: string, imports: Record<string, unknown>, fetcher = fetch) {
  const exports: Record<string, any> = {}, require = createRequire(import.meta.url)
  vm.runInNewContext(ts.transpileModule(readFileSync(path.resolve(__dirname,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:(key:string)=>key in imports?imports[key]:require(key),fetch:fetcher,Response,URL,AbortSignal,Buffer,Uint8Array,Date,process,console})
  return exports
}
test('verification limits accept eight and reject values above the supported range',()=>{
  assert.equal(policy.settingsSchema.parse({agentDailyLimit:8,maxConcurrent:8}).maxConcurrent,8)
  assert.equal(policy.settingsSchema.parse({agentDailyLimit:8}).agentDailyLimit,8)
  assert.throws(()=>policy.settingsSchema.parse({maxConcurrent:11}))
})

test('strict evaluator decisions and randomized PNG inputs',()=>{
  assert.equal(policy.assessmentStatus({verdict:'pass',confidence:0.99,criteria:[{name:'matches',passed:true}],reason:'Matched'}),'passed')
  assert.equal(policy.assessmentStatus({verdict:'pass',confidence:0.99,criteria:[{name:'matches',passed:false}],reason:'Conflict'}),'review_required')
  assert.equal(policy.assessmentStatus({verdict:'pass',confidence:0.4,criteria:[{name:'matches',passed:true}],reason:'Unclear'}),'review_required')
  assert.throws(()=>policy.assessmentStatus({verdict:'pass',confidence:1,criteria:[],reason:'Trust me'}))
  assert.deepEqual(policy.parseCapabilities('image_editing,bogus,image_editing'),['image_editing'])
  for(let i=0;i<3;i++)assert.ok(matchesFileHeader('image/png',fixture.imageFixture(i).bytes))
})

test('isolated PostgreSQL: real delivery, idempotency, AI decisions, cancellation and accounting isolation', {skip:!process.env.TEST_VERIFICATION_DATABASE_URL,timeout:450000},async()=>{
  const url=new URL(process.env.TEST_VERIFICATION_DATABASE_URL!)
  assert.equal(url.pathname,'/agentjob_tests')
  const schema='verification_'+randomUUID().replaceAll('-','')
  const admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:8000,query_timeout:8000})
  const pool=new Pool({connectionString:url.href,max:5,connectionTimeoutMillis:8000,query_timeout:8000,options:'-c search_path='+schema+',public'})
  const previous=(globalThis as any).agentjobPool, oldEnv={...process.env}
  const uid=randomUUID(),aid=randomUUID()
  let evaluations=0, mode='pass', adminAllowed=true
  const storageBytes=new Map<string,Buffer>()
  const storage={attachmentsConfigured:()=>true,uploadUrl:async(id:string)=>'https://storage.invalid/'+id,
    finalizeObject:async()=>{},downloadUrl:async(id:string)=>'https://storage.invalid/'+id}
  const fakeFetch:typeof fetch=async(input,init)=>{
    const u=String(input)
    if(u.startsWith('https://storage.invalid/')){
      if(init?.method==='PUT'){storageBytes.set(u,Buffer.from(init.body as Uint8Array));return new Response('')}
      return new Response(new Uint8Array(storageBytes.get(u)!))
    }
    assert.equal(u,'https://evaluator.invalid/chat/completions');evaluations++
    if(mode==='error')return new Response('',{status:503})
    const body=JSON.parse(String(init?.body))
    assert.ok(body.messages[0].content.includes('untrusted'))
    assert.equal(body.tools,undefined)
    const criteria=JSON.parse(body.messages[1].content[0].text).required_criteria.map((name:string)=>({name,passed:mode==='pass'}))
    return Response.json({choices:[{message:{content:JSON.stringify({verdict:mode,confidence:mode==='uncertain'?0.5:0.99,criteria,reason:'Simulated independent assessment'})}}]})
  }
  try{
    await admin.query('CREATE SCHEMA '+schema)
    for(const table of ['users','agent_profiles','agent_chat_tasks','chats','messages','payments','platform_config','agent_daily_stats','user_agent_free_used'])await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING ALL)')
    for(const file of ['0005_agent_free_messages_per_user.sql','0006_chat_attachments.sql','0007_chat_deliveries.sql','0008_agent_verification.sql','0009_verification_queue.sql','0010_agent_runtime_info.sql','0011_runtime_inquiry.sql'])await pool.query(readFileSync(path.resolve(__dirname,'../../../../packages/db/migrations/'+file),'utf8'))
    ;(globalThis as any).agentjobPool=pool
    Object.assign(process.env,{AGENT_VERIFICATION_ENABLED:'true',VERIFICATION_EVALUATOR_URL:'https://evaluator.invalid/chat/completions',VERIFICATION_EVALUATOR_KEY:'test-only',VERIFICATION_EVALUATOR_MODEL:'simulated',INTERNAL_API_SECRET:'test-only'})
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[uid,uid+'@example.invalid'])
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,api_key_hash,price_first_msg,price_subsequent,last_heartbeat_at) VALUES($1,$2,'Verification fixture','test-only',0.1,0.1,now())",[aid,uid])
    await pool.query("INSERT INTO platform_config(key,value) VALUES('verification_settings',$1)",[JSON.stringify({dailyLimit:50,agentDailyLimit:10,maxConcurrent:2,timeoutMinutes:2,validDays:14})])
    const core=load('agent-verification.ts',{'./agent-runtime-info':runtime,'./db':db,'./chat-attachment-storage':storage,'./chat-attachments':{attachmentCapabilities:async()=>['image/png']},'./verification-fixture':fixture,'./verification-policy':policy},fakeFetch)
    const imports={'@/lib/agent-runtime-info':{runtimeInfo:async()=>null,runtimeInfoSchema: (await import('./agent-runtime-info')).runtimeInfoSchema,approveRuntimeInfo:async()=>true},'@/lib/db':db,'@/lib/agent-auth':{verifyAgentApiKey:async()=>({id:aid})},'@/lib/provider-deliveries':{readyOutputs:async(_a:string,_t:string,ids:string[])=>ids.map(id=>({id,name:'output.png',contentType:'image/png',size:fixture.imageFixture(0).bytes.length}))},'@/lib/agent-reply':{isRawToolReply:(text:string)=>text.includes('DSML')},'@/lib/chat-attachments':{providerAttachments:async(m:unknown)=>m},'@/lib/session':{requireAdmin:async()=>{if(!adminAllowed)throw Error('Forbidden');return {userId:uid}}},'@/lib/agent-verification':core,'@/lib/verification-policy':policy,'@/lib/audit':{writeAuditLog:()=>{}}}
    const respond=load('../app/api/agents/tasks/[taskId]/response/route.ts',imports)
    const poll=load('../app/api/agents/tasks/route.ts',imports)
    const api=load('../app/api/admin/verification/route.ts',imports)
    const request=(body:unknown)=>new NextRequest('https://local.invalid/api',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(body)})
    adminAllowed=false
    assert.equal((await api.POST(request({action:'start',agentId:aid,capability:'text_chat',requestKey:randomUUID()}))).status,403)
    adminAllowed=true
    await assert.rejects(core.startVerification(uid,aid,'text_chat',randomUUID()),/agreement/)
    await pool.query("INSERT INTO agent_verification_permissions(agent_id,recorded_by,policy_version) VALUES($1,$2,'1')",[aid,uid])
    await core.recordServiceRevision(aid,'service-v1')
    const key=randomUUID()
    const ids=await Promise.all([core.startVerification(uid,aid,'text_chat',key),core.startVerification(uid,aid,'text_chat',key)])
    assert.equal(ids[0],ids[1])
    console.log('verification fixture: idempotent start passed')
    await assert.rejects(core.startVerification(uid,aid,'text_chat',randomUUID()),/queued|limit/)
    const row=async(id:string)=>(await pool.query('SELECT * FROM agent_verification_runs WHERE id=$1',[id])).rows[0]
    const reply=async(id:string,text:string,attachmentIds:string[]=[])=>{
      const r=await row(id)
      const delivered=await poll.GET(new NextRequest('https://local.invalid/api?wait=5',{headers:{authorization:'Bearer test','x-agentjob-attachment-types':'image/png'}}))
      const payload=await delivered.json();assert.equal(payload.task.id,r.task_id);assert.equal(payload.task.verification_run_id,undefined)
      const response=await respond.POST(request({text,attachmentIds}),{params:Promise.resolve({taskId:r.task_id})})
      // Advance past the short scheduler poll lease without sleeping in the test.
      await pool.query('UPDATE agent_verification_runs SET lease_until=NULL WHERE id=$1',[id])
      return response
    }
    await Promise.all([core.processVerification(),core.processVerification()])
    console.log('verification fixture: first dispatch passed')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks')).rows[0].n,1)
    assert.equal((await reply(ids[0],'Noted.')).status,200)
    console.log('verification fixture: first reply passed')
    await core.processVerification()
    const r=await row(ids[0]);assert.equal(r.phase,1)
    assert.equal((await reply(ids[0],r.challenge.token)).status,200)
    await core.processVerification()
    assert.equal((await row(ids[0])).status,'passed');assert.equal(evaluations,1)
    console.log('verification fixture: text assessment passed')
    await core.processVerification();assert.equal(evaluations,1)
    assert.equal((await core.publicVerification(aid))[0].valid,true)
    // Pending or inconclusive retests retain an unexpired pass; explicit failure removes it.
    const cancelId=await core.startVerification(uid,aid,'text_chat',randomUUID())
    assert.equal((await core.publicVerification(aid))[0].valid,true)
    await core.processVerification();const cancelled=await row(cancelId)
    await core.cancelVerification(cancelId)
    assert.equal((await core.publicVerification(aid))[0].valid,true)
    await pool.query("UPDATE agent_verification_runs SET status='review_required' WHERE id=$1",[cancelId])
    assert.equal((await core.publicVerification(aid))[0].valid,true)
    await pool.query("UPDATE agent_verification_runs SET status='failed' WHERE id=$1",[cancelId])
    assert.equal((await core.publicVerification(aid))[0].valid,false)
    await pool.query("UPDATE agent_verification_runs SET status='cancelled' WHERE id=$1",[cancelId])
    await pool.query("UPDATE agent_verification_runs SET valid_until=now()-interval '1 second' WHERE id=$1",[ids[0]])
    assert.equal((await core.publicVerification(aid))[0].valid,false)
    await pool.query("UPDATE agent_verification_runs SET valid_until=now()+interval '14 days' WHERE id=$1",[ids[0]])
    assert.equal((await respond.POST(request({text:'late'}),{params:Promise.resolve({taskId:cancelled.task_id})})).status,409)
    // Reading test: real reference PNG bytes pass through the upload fixture and evaluator.
    mode='uncertain'
    const imageId=await core.startVerification(uid,aid,'image_understanding',randomUUID())
    await core.processVerification();assert.equal((await reply(imageId,'A square and a circle.')).status,200)
    await core.processVerification();assert.equal((await row(imageId)).status,'review_required')
    // An output without a new image must fail even if the evaluator would pass it.
    mode='pass'
    const genId=await core.startVerification(uid,aid,'image_generation',randomUUID())
    await core.processVerification();assert.equal((await reply(genId,'Image created.')).status,200)
    await core.processVerification();assert.equal((await row(genId)).status,'failed')
    for(const capability of ['image_generation','image_editing']){
      const mediaId=await core.startVerification(uid,aid,capability,randomUUID())
      await core.processVerification()
      const fileId=randomUUID();storageBytes.set('https://storage.invalid/'+fileId,fixture.imageFixture(0).bytes)
      assert.equal((await reply(mediaId,'',[fileId])).status,200)
      await core.processVerification();assert.equal((await row(mediaId)).status,'passed')
    }
    await core.recordServiceRevision(aid,'service-v2')
    assert.equal((await core.publicVerification(aid)).some((r:any)=>r.valid),false)
    // Failed evaluator must not retry automatically or publish certification.
    mode='error'
    const errorId=await core.startVerification(uid,aid,'image_understanding',randomUUID())
    await core.processVerification();await reply(errorId,'Two shapes.');await core.processVerification()
    assert.equal((await row(errorId)).status,'error')
    const prior=evaluations;await core.processVerification();assert.equal(evaluations,prior)
    const expired=await core.startVerification(uid,aid,'text_chat',randomUUID())
    await core.processVerification();await pool.query("UPDATE agent_verification_runs SET deadline=now()-interval '1 second' WHERE id=$1",[expired]);await core.processVerification()
    assert.equal((await row(expired)).status,'error')
    for(const name of ['chats','messages','payments','agent_daily_stats','user_agent_free_used'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n,0,name+' must remain empty')
    const stats=(await pool.query('SELECT total_chats,no_response_count,total_revenue FROM agent_profiles WHERE id=$1',[aid])).rows[0]
    assert.equal(stats.total_chats,0);assert.equal(stats.no_response_count,0);assert.equal(Number(stats.total_revenue),0)
    // Existing consumer replies still persist and increment statistics with a NULL discriminator.
    const chatId=randomUUID(),taskId=randomUUID()
    await pool.query('INSERT INTO chats(id,user_id,agent_id) VALUES($1,$2,$3)',[chatId,uid,aid])
    await pool.query("INSERT INTO agent_chat_tasks(id,user_id,agent_id,chat_id,messages,amount_usdc,status,timeout_at) VALUES($1,$2,$3,$4,'[]',0.1,'claimed',now()+interval '1 minute')",[taskId,uid,aid,chatId])
    assert.equal((await respond.POST(request({text:'Normal reply'}),{params:Promise.resolve({taskId})})).status,200)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n,1)
    assert.equal((await pool.query('SELECT total_chats FROM agent_profiles WHERE id=$1',[aid])).rows[0].total_chats,1)
    // No API key: enqueue all capabilities atomically, execute sequentially, never auto-certify.
    delete process.env.VERIFICATION_EVALUATOR_KEY
    const uid2=randomUUID(),aid2=randomUUID(),batchKey=randomUUID()
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[uid2,uid2+'@example.invalid'])
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,api_key_hash,price_first_msg,price_subsequent,last_heartbeat_at) VALUES($1,$2,'Batch fixture','test-only',0.1,0.1,now())",[aid2,uid2])
    await pool.query("INSERT INTO agent_verification_permissions(agent_id,recorded_by,policy_version) VALUES($1,$2,'1')",[aid2,uid])
    const caps=Object.keys(policy.CAPABILITIES)
    // An invalid second Agent rolls back the entire batch, including the valid first Agent.
    await assert.rejects(core.startVerificationBatch(uid,[aid2,randomUUID()],caps,randomUUID()),/online/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_verification_runs WHERE agent_id=$1',[aid2])).rows[0].n,0)
    const batch=await core.startVerificationBatch(uid,[aid2],caps,batchKey)
    assert.equal(batch.length,4)
    assert.deepEqual([...(await core.startVerificationBatch(uid,[aid2],caps.reverse(),batchKey))].sort(),[...batch].sort())
    await assert.rejects(core.startVerificationBatch(uid,[aid2],['text_chat'],batchKey),/conflict/)
    const judgeCalls=evaluations
    // Queuing time does not consume an execution deadline.
    await pool.query("UPDATE agent_verification_runs SET deadline=now()-interval '1 hour' WHERE batch_key=$1",[batchKey])
    await Promise.all([core.processVerification(),core.processVerification()])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks WHERE agent_id=$1',[aid2])).rows[0].n,1)
    for(let tick=0;tick<15;tick++){
      const active=(await pool.query("SELECT * FROM agent_verification_runs WHERE agent_id=$1 AND status IN ('queued','running','evaluating') ORDER BY queue_order",[aid2])).rows
      if(!active.length)break
      assert.ok(active.filter(r=>r.status!=='queued').length<=1)
      for(const r of active.filter(r=>r.task_id)){
        const fileId=randomUUID(),bytes=fixture.imageFixture(0).bytes
        storageBytes.set('https://storage.invalid/'+fileId,bytes)
        const files=['image_generation','image_editing'].includes(r.capability)?[{id:fileId,name:'output.png',contentType:'image/png',size:bytes.length}]:[]
        await pool.query("UPDATE agent_chat_tasks SET status='completed',response_text=$2,response_attachments=$3 WHERE id=$1",[r.task_id,r.challenge.token,JSON.stringify(files)])
      }
      await pool.query('UPDATE agent_verification_runs SET lease_until=NULL WHERE agent_id=$1',[aid2])
      await core.processVerification()
    }
    const outcomes=(await pool.query('SELECT status FROM agent_verification_runs WHERE batch_key=$1',[batchKey])).rows
    assert.equal(outcomes.length,4);assert.ok(outcomes.every(r=>r.status==='review_required'))
    assert.equal(evaluations,judgeCalls)
    assert.equal((await core.publicVerification(aid2)).some((r:any)=>r.valid),false)
    await pool.query('UPDATE agent_profiles SET last_heartbeat_at=now() WHERE id=$1',[aid2])
    const [inquiry]=await core.startVerificationBatch(uid,[aid2],['runtime_info'],randomUUID())
    await core.processVerification()
    const inquiryRun=await row(inquiry)
    await pool.query("UPDATE agent_chat_tasks SET status='completed',response_text=$2 WHERE id=$1",[inquiryRun.task_id,JSON.stringify({framework:'OpenClaw v2026.11',model:'Unknown'})])
    await core.processVerification()
    const declaration=(await pool.query('SELECT self_report,approved FROM agent_runtime_info WHERE agent_id=$1',[aid2])).rows[0]
    assert.equal(declaration.self_report.framework,'OpenClaw');assert.equal(declaration.self_report.source,'agent');assert.equal(declaration.approved,null)
    assert.equal((await core.publicVerification(aid2)).some((r:any)=>r.capability==='runtime_info'),false)
    assert.equal((await api.POST(request({action:'review',id:inquiry,verdict:'passed',reason:'Must not certify a model declaration'}))).status,409)
    assert.equal(evaluations,judgeCalls)

  }finally{
    (globalThis as any).agentjobPool=previous
    for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key]
    Object.assign(process.env,oldEnv)
    await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()
  }
})
