import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import { skillTags, modelTags, frameworkTags, runtimeTags, agentTypeTags } from '@agentjob/db'
import { ok, err } from '@/lib/api-response'

const SKILLS = [
  { name: 'Chat', nameEn: 'chat', sortOrder: 1 },
  { name: 'Writing', nameEn: 'writing', sortOrder: 2 },
  { name: 'Translation', nameEn: 'translation', sortOrder: 3 },
  { name: 'Coding', nameEn: 'coding', sortOrder: 4 },
  { name: 'Debugging', nameEn: 'debugging', sortOrder: 5 },
  { name: 'Data Analysis', nameEn: 'data_analysis', sortOrder: 6 },
  { name: 'Research', nameEn: 'research', sortOrder: 7 },
  { name: 'Image Generation', nameEn: 'image_generation', sortOrder: 8 },
  { name: 'Video Generation', nameEn: 'video_generation', sortOrder: 9 },
  { name: 'Audio Generation', nameEn: 'audio_generation', sortOrder: 10 },
  { name: 'Prompt Engineering', nameEn: 'prompt_engineering', sortOrder: 11 },
  { name: 'SEO', nameEn: 'seo', sortOrder: 12 },
  { name: 'Marketing', nameEn: 'marketing', sortOrder: 13 },
  { name: 'Social Media', nameEn: 'social_media', sortOrder: 14 },
  { name: 'Web Scraping', nameEn: 'web_scraping', sortOrder: 15 },
  { name: 'Automation', nameEn: 'automation', sortOrder: 16 },
  { name: 'AI Workflow', nameEn: 'ai_workflow', sortOrder: 17 },
  { name: 'Blockchain', nameEn: 'blockchain', sortOrder: 18 },
  { name: 'Smart Contract', nameEn: 'smart_contract', sortOrder: 19 },
  { name: 'Trading Strategy', nameEn: 'trading_strategy', sortOrder: 20 },
  { name: 'DeFi Analysis', nameEn: 'defi_analysis', sortOrder: 21 },
  { name: 'Game Bot', nameEn: 'game_bot', sortOrder: 22 },
  { name: 'Customer Support', nameEn: 'customer_support', sortOrder: 23 },
  { name: 'Education / Tutoring', nameEn: 'education', sortOrder: 24 },
  { name: 'Personal Assistant', nameEn: 'personal_assistant', sortOrder: 25 },
]

const MODELS = [
  { name: 'GPT-4o', provider: 'OpenAI', sortOrder: 1 },
  { name: 'GPT-4.1', provider: 'OpenAI', sortOrder: 2 },
  { name: 'Claude 3.5 Sonnet', provider: 'Anthropic', sortOrder: 3 },
  { name: 'Claude 3 Opus', provider: 'Anthropic', sortOrder: 4 },
  { name: 'Gemini 2.0', provider: 'Google', sortOrder: 5 },
  { name: 'DeepSeek V3', provider: 'DeepSeek', sortOrder: 6 },
  { name: 'DeepSeek R1', provider: 'DeepSeek', sortOrder: 7 },
  { name: 'Qwen 2.5', provider: 'Alibaba', sortOrder: 8 },
  { name: 'Llama 3', provider: 'Meta', sortOrder: 9 },
  { name: 'Mistral Large', provider: 'Mistral', sortOrder: 10 },
  { name: 'Custom Model', provider: null, sortOrder: 11 },
  { name: 'Multi Model', provider: null, sortOrder: 12 },
]

const FRAMEWORKS = [
  { name: 'LangChain', sortOrder: 1 },
  { name: 'LangGraph', sortOrder: 2 },
  { name: 'CrewAI', sortOrder: 3 },
  { name: 'AutoGPT', sortOrder: 4 },
  { name: 'agency-agents', sortOrder: 5 },
  { name: 'Semantic Kernel', sortOrder: 6 },
  { name: 'Haystack', sortOrder: 7 },
  { name: 'smolagents', sortOrder: 8 },
  { name: 'OpenAI Agents SDK', sortOrder: 9 },
  { name: 'Custom Framework', sortOrder: 10 },
]

const RUNTIMES = [
  { name: 'Server', sortOrder: 1 },
  { name: 'Local', sortOrder: 2 },
  { name: 'OpenClaw', sortOrder: 3 },
  { name: 'Claude Desktop', sortOrder: 4 },
  { name: 'Cursor', sortOrder: 5 },
  { name: 'Docker', sortOrder: 6 },
  { name: 'Cloud Function', sortOrder: 7 },
  { name: 'Telegram Bot', sortOrder: 8 },
  { name: 'Discord Bot', sortOrder: 9 },
  { name: 'Web App', sortOrder: 10 },
  { name: 'Mobile App', sortOrder: 11 },
]

const AGENT_TYPES = [
  { name: 'Chat Agent', sortOrder: 1 },
  { name: 'Companion Agent', sortOrder: 2 },
  { name: 'Research Agent', sortOrder: 3 },
  { name: 'Developer Agent', sortOrder: 4 },
  { name: 'Automation Agent', sortOrder: 5 },
  { name: 'Trading Agent', sortOrder: 6 },
  { name: 'Creator Agent', sortOrder: 7 },
  { name: 'Customer Support Agent', sortOrder: 8 },
  { name: 'Education Agent', sortOrder: 9 },
  { name: 'Game Agent', sortOrder: 10 },
  { name: 'Assistant Agent', sortOrder: 11 },
  { name: 'Multi-purpose Agent', sortOrder: 12 },
]

/**
 * POST /api/admin/seed-tags
 * Seed five tag tables (idempotent, skips existing rows).
 * Header: Authorization: Bearer {INTERNAL_API_SECRET}
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.replace('Bearer ', '').trim()
  if (!token || token !== process.env.INTERNAL_API_SECRET) {
    return err('Unauthorized', 401)
  }

  const db = getDb()

  const results = await Promise.all([
    db.insert(skillTags).values(SKILLS).onConflictDoNothing().returning({ id: skillTags.id }),
    db.insert(modelTags).values(MODELS).onConflictDoNothing().returning({ id: modelTags.id }),
    db.insert(frameworkTags).values(FRAMEWORKS).onConflictDoNothing().returning({ id: frameworkTags.id }),
    db.insert(runtimeTags).values(RUNTIMES).onConflictDoNothing().returning({ id: runtimeTags.id }),
    db.insert(agentTypeTags).values(AGENT_TYPES).onConflictDoNothing().returning({ id: agentTypeTags.id }),
  ])

  return ok({
    inserted: {
      skills: results[0].length,
      models: results[1].length,
      frameworks: results[2].length,
      runtimes: results[3].length,
      agentTypes: results[4].length,
    },
  })
}
