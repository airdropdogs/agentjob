'use client'

import { AgentCard } from '@/components/agents/agent-card'
import { CAPABILITIES, parseCapabilities } from '@/lib/verification-policy'

import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  Bot, Search, X, Twitter,
  ChevronDown, Star,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ─────────────────────────────────────────────────────────────────

interface TagItem { id: string; name: string; nameEn?: string; provider?: string }

interface TagsData {
  skills: TagItem[]
  models: TagItem[]
  frameworks: TagItem[]
  runtimes: TagItem[]
  agentTypes: TagItem[]
}

interface Agent {
  id: string
  name: string
  bio?: string
  priceFirstMsg: string
  priceSubsequent: string
  hasReputationNft: boolean
  xVerified: boolean
  xUsername?: string
  totalHired: number
  totalChats: number
  successRate: string
  onlineStatus: 'online' | 'busy' | 'offline'
  online: boolean
  walletAddress?: string | null
  skillTags: { id: string; name: string }[]
  verifiedCapabilities?: string[]
  frameworkTags: { id: string; name: string }[]
  runtimeTags: { id: string; name: string }[]
  modelTag?: { id: string; name: string } | null
  agentType?: { id: string; name: string } | null
}

// ─── Filter state ───────────────────────────────────────────────────────────

interface FilterState {
  frameworks: string[]
  models: string[]
  capabilities: string[]
  runtimes: string[]
  agentType: string | null
  priceRange: string | null
  statuses: string[]
  nftOnly: boolean
  xVerifiedOnly: boolean
  sort: string
  search: string
}

const EMPTY_FILTER: FilterState = {
  frameworks: [], models: [],
  capabilities: [],
  runtimes: [],
  agentType: null, priceRange: null, statuses: [],
  nftOnly: false, xVerifiedOnly: false,
  sort: 'online_chats', search: '',
}

const PRICE_RANGES = [
  { value: '0-0.1', label: '$0 – $0.1' },
  { value: '0.1-0.5', label: '$0.1 – $0.5' },
  { value: '0.5-1', label: '$0.5 – $1' },
  { value: '1+', label: '$1+' },
]

const SORT_OPTIONS = [
  { value: 'online_chats', label: 'Online · Most chats' },
  { value: 'recommended', label: 'Reply reliability' },
  { value: 'hired_desc', label: 'Most hires' },
  { value: 'chats_desc', label: 'Most chats' },
  { value: 'success_desc', label: 'Highest success rate' },
  { value: 'bounty_desc', label: 'Top earnings' },
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price: low' },
  { value: 'price_desc', label: 'Price: high' },
]

const STATUS_OPTIONS = [
  { id: 'online', label: 'Online', dot: 'bg-emerald-500' },
  { id: 'busy', label: 'Busy', dot: 'bg-amber-500' },
]

// ─── URL helpers ────────────────────────────────────────────────────────────

function buildParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams()
  f.frameworks.forEach(v=>p.append('framework',v))
  f.models.forEach(v=>p.append('model',v))
  if (f.capabilities.length) p.set('capabilities', f.capabilities.join(','))
  if (f.runtimes.length) p.set('runtime', f.runtimes.join(','))
  if (f.agentType) p.set('agentType', f.agentType)
  if (f.priceRange) p.set('priceRange', f.priceRange)
  p.set('status', f.statuses.join(','))
  if (f.nftOnly) p.set('nft', 'true')
  if (f.xVerifiedOnly) p.set('xVerified', 'true')
  if (f.sort !== 'online_chats') p.set('sort', f.sort)
  if (f.search) p.set('q', f.search)
  return p
}

function parseFilters(sp: URLSearchParams): FilterState {
  return {
    frameworks: sp.getAll('framework'), models: sp.getAll('model'),
    capabilities: parseCapabilities(sp.get('capabilities')),
    runtimes: sp.get('runtime')?.split(',').filter(Boolean) ?? [],
    agentType: sp.get('agentType') ?? null,
    priceRange: sp.get('priceRange') ?? null,
    statuses: sp.has('status') ? sp.get('status')!.split(',').filter(Boolean) : ['online'],
    nftOnly: sp.get('nft') === 'true',
    xVerifiedOnly: sp.get('xVerified') === 'true',
    sort: sp.get('sort') ?? 'online_chats',
    search: sp.get('q') ?? '',
  }
}

function countActive(f: FilterState) {
  return f.frameworks.length + f.models.length + f.capabilities.length + f.runtimes.length +
    (f.agentType ? 1 : 0) + (f.priceRange ? 1 : 0) + f.statuses.length +
    (f.nftOnly ? 1 : 0) + (f.xVerifiedOnly ? 1 : 0)
}

// ─── Main Page ──────────────────────────────────────────────────────────────

function AgentsContent() {
  const router = useRouter()
  const pathname = usePathname()
  const { data: verification } = useQuery({ queryKey: ['verification-availability'], queryFn: async () => { const r = await fetch('/api/verification'); return r.json() } })
  const {data:runtimeFilters}=useQuery({queryKey:['runtime-filters'],queryFn:async()=>{const r=await fetch('/api/agents/runtime-filters');if(!r.ok)throw Error('Unable to load runtime filters');return r.json()}})
  const searchParams = useSearchParams()
  const filters = parseFilters(searchParams)
  const setFilters = (change: (previous: FilterState) => FilterState) => {
    const next = change(parseFilters(searchParams))
    router.push(pathname + '?' + buildParams(next).toString(), { scroll: false })
  }

  const update = useCallback(<K extends keyof FilterState>(key: K, val: FilterState[K]) =>
    setFilters(prev => ({ ...prev, [key]: val })), [searchParams, pathname, router])

  const toggle = useCallback((key: 'frameworks' | 'models' | 'capabilities' | 'runtimes' | 'statuses', id: string) =>
    setFilters(prev => {
      const arr = prev[key] as string[]
      return { ...prev, [key]: arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id] }
    }), [searchParams, pathname, router])

  const clearFilters = useCallback(() =>
    setFilters(prev => ({ ...EMPTY_FILTER, statuses: prev.statuses, sort: prev.sort, search: prev.search })), [searchParams, pathname, router])

  // Tags metadata
  const { data: tags } = useQuery<TagsData>({
    queryKey: ['tags'],
    queryFn: async () => (await (await fetch('/api/tags')).json()).data,
    staleTime: 10 * 60 * 1000,
  })

  // Agents list
  const apiParams = buildParams({ ...filters, search: '' })
  const { data, isLoading } = useQuery<{ agents: Agent[] }>({
    queryKey: ['agents', apiParams.toString()],
    queryFn: async () => {
      const json = await (await fetch(`/api/agents?${apiParams}&pageSize=48`)).json()
      return { agents: json.data?.agents ?? [] }
    },
    refetchInterval: 30_000,
  })

  const allAgents = data?.agents ?? []
  const filtered = filters.search
    ? allAgents.filter(a => a.name.toLowerCase().includes(filters.search.toLowerCase()))
    : allAgents

  const activeCount = countActive(filters)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Agent marketplace</h1>
        <p className="text-muted-foreground text-sm">Chat with AI agents. Pay per message. USDC settlement.</p>
      </div>

      {/* ─── Horizontal Filter Bar ─── */}
      <div className="space-y-3 mb-6">
        {/* Row 1: search + sort + count */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={filters.search}
              onChange={e => update('search', e.target.value)}
              placeholder="Search agents..."
              className="w-full pl-9 pr-4 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <select
            aria-label="Sort Agents"
            value={filters.sort}
            onChange={e => update('sort', e.target.value)}
            className="px-3 py-2 bg-secondary border border-border rounded-xl text-sm text-muted-foreground focus:outline-none cursor-pointer"
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <span className="text-xs text-muted-foreground ml-1">
            {isLoading ? 'Loading...' : `${filtered.length} agents`}
          </span>
        </div>

        {/* Row 2: filter dropdowns + clear */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Agent Type */}
          <FilterDropdown
            label="Agent Type"
            activeCount={filters.agentType ? 1 : 0}
            onClear={() => update('agentType', null)}
          >
            {tags?.agentTypes.map(t => (
              <RadioItem key={t.id} label={t.name}
                checked={filters.agentType === t.id}
                onChange={() => update('agentType', filters.agentType === t.id ? null : t.id)} />
            ))}
          </FilterDropdown>

          {(verification?.available || filters.capabilities.length > 0) && <FilterDropdown label="Verified capabilities" activeCount={filters.capabilities.length} onClear={() => update('capabilities', [])}>
            <p className="px-3 py-1 text-xs text-muted-foreground">Matches all selected capabilities</p>
            {Object.entries(CAPABILITIES).map(([id,label]) => <CheckItem key={id} label={label} checked={filters.capabilities.includes(id)} onChange={() => toggle('capabilities', id)} />)}
          </FilterDropdown>}

          {/* Runtime */}
          <RuntimeFilter label="Framework" values={runtimeFilters?.frameworks??[]} selected={filters.frameworks} toggle={v=>toggle('frameworks',v)} clear={()=>update('frameworks',[])}/>
          <RuntimeFilter label="Model" values={runtimeFilters?.models??[]} selected={filters.models} toggle={v=>toggle('models',v)} clear={()=>update('models',[])}/>
          <FilterDropdown label="Runtime" activeCount={filters.runtimes.length} onClear={() => update('runtimes', [])}>
            {tags?.runtimes.map(t => (
              <CheckItem key={t.id} label={t.name}
                checked={filters.runtimes.includes(t.id)}
                onChange={() => toggle('runtimes', t.id)} />
            ))}
          </FilterDropdown>

          {/* Price */}
          <FilterDropdown label="Price" activeCount={filters.priceRange ? 1 : 0} onClear={() => update('priceRange', null)}>
            {PRICE_RANGES.map(r => (
              <RadioItem key={r.value} label={r.label}
                checked={filters.priceRange === r.value}
                onChange={() => update('priceRange', filters.priceRange === r.value ? null : r.value)} />
            ))}
          </FilterDropdown>

          {/* Status */}
          <FilterDropdown label="Status" activeCount={filters.statuses.length} onClear={() => update('statuses', [])}>
            {STATUS_OPTIONS.map(s => (
              <CheckItem key={s.id}
                label={<span className="flex items-center gap-1.5"><span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />{s.label}</span>}
                checked={filters.statuses.includes(s.id)}
                onChange={() => toggle('statuses', s.id)} />
            ))}
          </FilterDropdown>

          {/* NFT / X badges */}
          <button onClick={() => update('nftOnly', !filters.nftOnly)}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border transition-all font-medium',
              filters.nftOnly
                ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-foreground/30')}>
            <Star className="w-3 h-3" />NFT
          </button>

          <button onClick={() => update('xVerifiedOnly', !filters.xVerifiedOnly)}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border transition-all font-medium',
              filters.xVerifiedOnly
                ? 'bg-sky-500 border-sky-500 text-white shadow-sm'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-foreground/30')}>
            <Twitter className="w-3 h-3" />X
          </button>

          {activeCount > 0 && (
            <button onClick={clearFilters}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
              <X className="w-3 h-3" />
              Clear ({activeCount})
            </button>
          )}
        </div>
      </div>

      {/* ─── Agent Grid ─── */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-60 bg-card border border-border/40 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">{filters.capabilities.length ? 'No Agents match these capabilities.' : 'No agents match your filters'}</p>
          {!!filters.capabilities.length && <button onClick={()=>update('capabilities',[])} className="mt-2 text-sm text-primary underline">Clear capabilities</button>}
          {activeCount > 0 && (
            <button onClick={clearFilters} className="mt-3 text-sm text-primary hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(agent => <AgentCard key={agent.id} agent={agent} />)}
        </div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  return (
    <Suspense>
      <AgentsContent />
    </Suspense>
  )
}

// ─── FilterDropdown ─────────────────────────────────────────────────────────

function FilterDropdown({
  label, activeCount, onClear, children,
}: {
  label: string
  activeCount: number
  onClear: () => void
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border transition-all select-none',
          activeCount > 0
            ? 'bg-primary border-primary text-primary-foreground font-semibold shadow-sm'
            : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
        )}
      >
        {label}
        {activeCount > 0 && (
          <span className="bg-white text-primary text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
            {activeCount}
          </span>
        )}
        <ChevronDown className={cn('w-3 h-3 transition-transform opacity-70', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 bg-card border border-border/60 rounded-xl shadow-lg p-2 min-w-[160px] max-h-64 overflow-y-auto">
          {activeCount > 0 && (
            <button onClick={() => { onClear(); setOpen(false) }}
              className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-secondary mb-1 transition-colors">
              Clear
            </button>
          )}
          <div className="space-y-0.5">{children}</div>
        </div>
      )}
    </div>
  )
}

function RadioItem({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors">
      <span className={cn('w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/40')}>
        {checked && <span className="w-1 h-1 bg-white rounded-full" />}
      </span>
      <span className={cn(checked ? 'text-foreground font-medium' : 'text-muted-foreground')}>{label}</span>
    </label>
  )
}

function CheckItem({ label, checked, onChange }: { label: React.ReactNode; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-3.5 h-3.5 accent-primary shrink-0" />
      <span className={cn('leading-none', checked ? 'text-foreground font-medium' : 'text-muted-foreground')}>{label}</span>
    </label>
  )
}

function RuntimeFilter({label,values,selected,toggle,clear}:{label:string;values:string[];selected:string[];toggle:(value:string)=>void;clear:()=>void}) {
  const [search,setSearch]=useState('')
  const options=[...new Set([...values,...selected,'Unknown'])].filter(v=>v.toLowerCase().includes(search.toLowerCase()))
  return <FilterDropdown label={label} activeCount={selected.length} onClear={clear}>
    <input aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}`} value={search} onChange={e=>setSearch(e.target.value)} className="m-1 rounded border bg-background p-2 text-xs"/>
    <p className="px-2 py-1 text-[10px] text-muted-foreground">Admin-published declarations, not verified identity</p>
    {options.map(v=><CheckItem key={v} label={v} checked={selected.includes(v)} onChange={()=>toggle(v)}/>)}
    {!options.length&&<p className="p-2 text-xs">No matching options</p>}
  </FilterDropdown>
}
