import { z } from 'zod'

export const CAPABILITIES = {
  text_chat: 'Text chat', image_understanding: 'Image understanding',
  image_generation: 'Image generation', image_editing: 'Image editing',
} as const
export type Capability = keyof typeof CAPABILITIES
export const capabilitySchema = z.enum(['text_chat', 'image_understanding', 'image_generation', 'image_editing'])
export const settingsSchema = z.object({
  dailyLimit: z.number().int().min(1).max(10000).default(1000),
  agentDailyLimit: z.number().int().min(1).max(1000).default(100),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  timeoutMinutes: z.number().int().min(2).max(30).default(10),
  validDays: z.number().int().min(1).max(90).default(14),
  evidenceRetentionDays: z.number().int().min(1).max(30).default(7),
})
export const assessmentSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  confidence: z.number().min(0).max(1),
  criteria: z.array(z.object({ name: z.string().max(100), passed: z.boolean() })).min(1).max(10),
  reason: z.string().min(1).max(1000),
}).strict()
export function assessmentStatus(input: unknown, required: string[] = []) {
  const a = assessmentSchema.parse(input)
  if (required.some(name => !a.criteria.some(c => c.name === name))) return 'review_required'
  if (a.confidence < 0.9 || a.verdict === 'uncertain') return 'review_required'
  if (a.verdict === 'pass' && a.criteria.every(c => c.passed)) return 'passed'
  if (a.verdict === 'fail') return 'failed'
  return 'review_required'
}
export function parseCapabilities(raw: string | null) {
  return [...new Set((raw ?? '').split(',').filter((v): v is Capability => Object.hasOwn(CAPABILITIES,v)))]
}
