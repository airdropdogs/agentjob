import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onrampClientIp, onrampNetworkReport } from './onramp-client-ip'

test('Cloudflare to Railway forwards the visitor instead of the last proxy hop', () => {
  assert.equal(onrampClientIp(new Headers({'x-real-ip':'172.64.1.2','x-forwarded-for':'203.0.113.7, 172.64.1.2','cf-connecting-ip':'203.0.113.7'})),'203.0.113.7')
  assert.equal(onrampClientIp(new Headers({'x-real-ip':'2606:4700::1','cf-connecting-ip':'240.1.2.3','cf-connecting-ipv6':'2001:db8::7'})),'2001:db8::7')
})

test('diagnostics reports trusted country and selection without addresses or tokens', () => {
  const headers=new Headers({'x-real-ip':'172.64.1.2','cf-connecting-ip':'203.0.113.7','cf-ipcountry':'US','x-forwarded-for':'203.0.113.7, 172.64.1.2','authorization':'Bearer secret'})
  const report=onrampNetworkReport(headers)
  assert.equal(report.cloudflareCountry,'US')
  assert.equal(report.source,'cf-connecting-ip')
  assert.equal(report.selectedMatchesLastForwardedHop,false)
  for(const secret of ['172.64.1.2','203.0.113.7','Bearer secret'])assert.equal(JSON.stringify(report).includes(secret),false)
  assert.equal(onrampNetworkReport(new Headers({'x-real-ip':'203.0.113.7','cf-ipcountry':'US'})).cloudflareCountry,null)
  assert.equal(onrampNetworkReport(new Headers()).code,'CLIENT_IP_UNAVAILABLE')
})

test('direct origin requests cannot spoof visitor headers; missing trusted identity fails closed', () => {
  assert.equal(onrampClientIp(new Headers({'x-real-ip':'203.0.113.9','cf-connecting-ip':'198.51.100.1','cf-connecting-ipv6':'2001:db8::7','x-forwarded-for':'198.51.100.1'})),'203.0.113.9')
  const invalid: Record<string,string>[] = [{},{'x-forwarded-for':'203.0.113.9'},{'x-real-ip':'172.64.1.2'},{'x-real-ip':'172.64.1.2','cf-connecting-ip':'bad'}]
  for (const headers of invalid) assert.throws(()=>onrampClientIp(new Headers(headers)),/Client address unavailable/)
})
