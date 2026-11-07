import { BlockList, isIP } from 'node:net'

// Published Cloudflare proxy ranges: https://www.cloudflare.com/ips/
const cloudflare = new BlockList()
for (const range of ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32']) {
  const [address,prefix] = range.split('/')
  cloudflare.addSubnet(address,Number(prefix),isIP(address)===6?'ipv6':'ipv4')
}

export function onrampClientIp(headers: Headers) {
  return resolveClientIp(headers).ip
}

function resolveClientIp(headers: Headers) {
  // Railway's edge supplies X-Real-IP for the immediate client. Never trust
  // arbitrary CF headers on requests sent straight to the Railway origin.
  const peer = headers.get('x-real-ip')?.trim() ?? ''
  const family = isIP(peer)
  if (!family) throw new Error('Client address unavailable')
  if (!cloudflare.check(peer,family===6?'ipv6':'ipv4')) return {ip:peer,source:'x-real-ip',cloudflare:false}
  // Preserve the real IPv6 address if Cloudflare Pseudo IPv4 is enabled.
  const ipv6 = headers.get('cf-connecting-ipv6')?.trim()
  if (ipv6 && isIP(ipv6)===6) return {ip:ipv6,source:'cf-connecting-ipv6',cloudflare:true}
  const visitor = headers.get('cf-connecting-ip')?.trim() ?? ''
  if (!isIP(visitor)) throw new Error('Client address unavailable')
  return {ip:visitor,source:'cf-connecting-ip',cloudflare:true}
}

export function onrampNetworkReport(headers: Headers) {
  const forwarded = (headers.get('x-forwarded-for')??'').split(',').map(v=>v.trim()).filter(Boolean)
  const country = headers.get('cf-ipcountry')??''
  try {
    const result=resolveClientIp(headers)
    return {
      version:1,checkedAt:new Date().toISOString(),code:'CLIENT_IP_RESOLVED',
      source:result.source,ipVersion:isIP(result.ip),trustedCloudflare:result.cloudflare,
      cloudflareCountry:result.cloudflare&&/^[A-Z]{2}$/.test(country)?country:null,
      forwardedHopCount:forwarded.length,
      selectedMatchesCloudflareVisitor:result.ip===headers.get('cf-connecting-ip')?.trim()||result.ip===headers.get('cf-connecting-ipv6')?.trim(),
      selectedMatchesLastForwardedHop:result.ip===forwarded.at(-1),
      countrySentToCoinbase:false,
    }
  } catch {
    return {version:1,checkedAt:new Date().toISOString(),code:'CLIENT_IP_UNAVAILABLE',forwardedHopCount:forwarded.length,countrySentToCoinbase:false}
  }
}
