import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { parseRuntimeReply, normalizeRuntimeInfo, runtimeInfo, recordRuntimeInfo, approveRuntimeInfo } from './agent-runtime-info'
import { settingsSchema } from './verification-policy'

test('runtime names omit framework versions but preserve model versions and unknowns',()=>{
  assert.deepEqual(normalizeRuntimeInfo({framework:'OpenClaw v2026.11.1',model:'deepseek-v3.2'}),{framework:'OpenClaw',model:'deepseek-v3.2'})
  assert.deepEqual(normalizeRuntimeInfo({framework:'',model:''}),{framework:'Unknown',model:'Unknown'})
  assert.deepEqual(parseRuntimeReply('I cannot disclose this.'),{framework:'Unknown',model:'Unknown'})
  assert.deepEqual(parseRuntimeReply('```json\n{"framework":"Codex v1.0","model":"gpt-test-2026"}\n```'),{framework:'Codex',model:'gpt-test-2026'})
  assert.equal(settingsSchema.parse({}).agentDailyLimit,100)
  assert.equal(settingsSchema.parse({dailyLimit:10000,agentDailyLimit:1000}).dailyLimit,10000)
  assert.throws(()=>settingsSchema.parse({maxConcurrent:11}))
})
test('runtime drafts need explicit approval; heartbeat cannot overwrite approved information', {skip:!process.env.TEST_VERIFICATION_DATABASE_URL},async()=>{
  const url=new URL(process.env.TEST_VERIFICATION_DATABASE_URL!)
  assert.equal(url.pathname,'/agentjob_tests')
  const schema='runtime_'+randomUUID().replaceAll('-','')
  const root=new Pool({connectionString:url.href}),pool=new Pool({connectionString:url.href,options:'-c search_path='+schema+',public'})
  const previous=(globalThis as any).agentjobPool,uid=randomUUID(),aid=randomUUID()
  try {
    await root.query('CREATE SCHEMA '+schema)
    for(const table of ['users','agent_profiles','model_tags','framework_tags','agent_framework_tags'])await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING ALL)')
    await pool.query(readFileSync(path.resolve(__dirname,'../../../../packages/db/migrations/0010_agent_runtime_info.sql'),'utf8'))
    await pool.query('ALTER TABLE agent_runtime_info ADD COLUMN self_report jsonb')
    ;(globalThis as any).agentjobPool=pool
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[uid,uid+'@example.invalid'])
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,price_first_msg,price_subsequent,api_key_hash) VALUES($1,$2,'Fixture',0,0,'fixture')",[aid,uid])
    assert.equal((await runtimeInfo(aid))?.draft.model,'Unknown')
    await recordRuntimeInfo(aid,{framework:'codex v1.2',model:'model-2026-11'})
    assert.equal((await runtimeInfo(aid))?.approved,null)
    await approveRuntimeInfo(aid,{framework:'Codex',model:'model-2026-11'},uid)
    assert.equal((await runtimeInfo(aid))?.approved.source,'connector')
    await recordRuntimeInfo(aid,{framework:'hermes',model:'Unknown'})
    assert.equal((await runtimeInfo(aid))?.approved.model,'model-2026-11')
    assert.equal((await runtimeInfo(aid))?.draft.framework,'Hermes')
    await approveRuntimeInfo(aid,{framework:'Custom v2',model:'Multiple models'},uid)
    assert.equal((await runtimeInfo(aid))?.approved.source,'admin')
    assert.equal((await runtimeInfo(aid))?.approved.framework,'Custom')
  } finally {
    ;(globalThis as any).agentjobPool=previous
    await pool.end();await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end()
  }
})
