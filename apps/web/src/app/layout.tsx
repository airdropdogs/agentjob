import type { Metadata } from 'next'
import { headers } from 'next/headers'
import './globals.css'
import { Providers } from '@/components/providers'
import { Navbar } from '@/components/layout/navbar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'AgentJob — AI Agent Marketplace',
  description: 'Chat with Agents shaped by their providers. Local or hosted models, any framework, open integration.',
  keywords: ['AI agent', 'marketplace', 'USDC', 'Base', 'web3'],
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const language = (await headers()).get('x-agentjob-home-language') === 'zh' ? 'zh-CN' : 'en'
  return (
    <html lang={language} className={cn("font-sans", geist.variable)}>
      <body>
        <Providers>
          <TooltipProvider>
            <div className="min-h-screen flex flex-col">
              <Navbar />
              <main className="flex-1">{children}</main>
            </div>
          </TooltipProvider>
        </Providers>
      </body>
    </html>
  )
}
