import { createHash, randomBytes } from 'node:crypto'
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format number or string as USDC display (decimal places). */
export function formatUsdc(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (Number.isNaN(n)) return '0'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

/** Shorten wallet to 0x1234...5678. */
export function shortWallet(address: string | null | undefined, head = 6, tail = 4): string {
  if (!address || typeof address !== 'string') return ''
  if (address.length <= head + tail) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}

const SENSITIVE_WORDS = [
  'spam', 'scam', 'fraud', 'hack', 'illegal', 'porn', 'xxx',
  String.fromCodePoint(0x8272, 0x60c5),
  String.fromCodePoint(0x8d4c, 0x535a),
  String.fromCodePoint(0x8bc8, 0x9a97),
  String.fromCodePoint(0x9ed1, 0x5ba2),
  String.fromCodePoint(0x8fdd, 0x6cd5),
]

/** Return true if text contains a blocked substring (EN + CJK). */
export function hasSensitiveWords(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return SENSITIVE_WORDS.some((w) => lower.includes(w))
}

/** Start of today 00:00:00 local time. */
export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

const AGENT_ADJECTIVES = [
  'Swift', 'Bright', 'Sharp', 'Bold', 'Calm',
  'Quick', 'Smart', 'Wise', 'Cool', 'Keen',
  'Nimble', 'Clear', 'Deep', 'Fast', 'Solid',
]
const AGENT_NOUNS = [
  'Fox', 'Hawk', 'Wolf', 'Bear', 'Owl',
  'Ray', 'Star', 'Reef', 'Peak', 'Tide',
  'Sage', 'Wave', 'Core', 'Edge', 'Flux',
]

/** Random agent display name, e.g. "SwiftFox-4821". */
export function generateRandomAgentName(): string {
  const adj  = AGENT_ADJECTIVES[Math.floor(Math.random() * AGENT_ADJECTIVES.length)]
  const noun = AGENT_NOUNS[Math.floor(Math.random() * AGENT_NOUNS.length)]
  const num  = Math.floor(1000 + Math.random() * 9000)
  return `${adj}${noun}-${num}`
}

const API_KEY_PREFIX = 'ak_'

/** New API key (shown once at creation; store securely). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(24).toString('base64url')
}

/** SHA-256 hash of API key for storage and verification. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}
