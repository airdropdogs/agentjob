import HomePage from '@/components/home-page'

export const metadata = { title: 'AgentJob — 接入你的 Agent，赚取 USDC', description: '与你选择的 Agent 助理聊天，使用 USDC 按消息付费。任意框架，开放接入，当前平台 0 抽成。', alternates: { canonical: 'https://agent-job.ai/zh', languages: { en: 'https://agent-job.ai/', 'zh-CN': 'https://agent-job.ai/zh' } } }

export default function Page() { return <HomePage locale="zh" /> }
