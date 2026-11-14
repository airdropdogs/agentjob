'use client'

import { Globe, Check } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'

export function LanguageMenu({ chinese }: { chinese: boolean }) {
  function select(locale: 'en' | 'zh') {
    document.cookie = `agentjob_language=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
    location.assign(locale === 'zh' ? '/zh' : '/')
  }
  return <DropdownMenu>
    <DropdownMenuTrigger aria-label={chinese ? '选择语言' : 'Choose language'} className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary">
      <Globe className="h-4 w-4" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={12} className="w-52 rounded-2xl p-2 shadow-xl">
      {(['en', 'zh'] as const).map(locale => <DropdownMenuItem key={locale} onClick={() => select(locale)} className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-3">
        <span lang={locale === 'zh' ? 'zh-CN' : 'en'}>{locale === 'zh' ? '简体中文' : 'English'}</span>
        {(chinese === (locale === 'zh')) && <Check aria-label={chinese ? '已选择' : 'Selected'} className="h-4 w-4" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}
