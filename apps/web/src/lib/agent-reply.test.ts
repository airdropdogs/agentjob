import test from 'node:test'
import assert from 'node:assert/strict'
import { isRawToolReply, displayAgentReply } from './agent-reply'

test('raw DSML calls are not rendered as a normal reply, including malformed blocks', () => {
  for (const text of ['<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="session_status">', '<|DSML|tool_calls>raw</|DSML|tool_calls>', '  <｜DSML｜invoke name="test">']) {
    assert.equal(isRawToolReply(text), true)
    assert.equal(displayAgentReply(text).includes('DSML'), false)
  }
})

test('normal answers and quoted technical examples stay intact', () => {
  for (const text of ['Hello!', 'That `<｜｜DSML｜｜ calls>` is a tool marker.', '```xml\n<｜｜DSML｜｜ calls>\n```']) {
    assert.equal(isRawToolReply(text), false)
    assert.equal(displayAgentReply(text), text)
  }
})
