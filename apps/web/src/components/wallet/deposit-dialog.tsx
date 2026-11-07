'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { Tabs } from '@base-ui/react/tabs'
import { Popover } from '@base-ui/react/popover'
import { Wallet, CircleHelp } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

function DepositHelp({ label, children }: { label: string; children: React.ReactNode }) {
  return <Popover.Root>
    <Popover.Trigger openOnHover delay={150} closeDelay={150} aria-label={label} className="mr-1 rounded-md p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
      <CircleHelp className="h-3.5 w-3.5" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={8} className="z-[60]">
        <Popover.Popup className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg outline-none">
          <Popover.Title className="mb-1.5 font-medium">{label}</Popover.Title>
          <div className="space-y-2 leading-relaxed">{children}</div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}

function BinanceIcon() {
  return <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#F0B90B]" fill="currentColor" aria-hidden="true">
    <path d="m12 2 5 5-2 2-3-3-3 3-2-2 5-5ZM2 12l3-3 3 3-3 3-3-3Zm7 0 3-3 3 3-3 3-3-3Zm7 0 3-3 3 3-3 3-3-3Zm-9 5 2-2 3 3 3-3 2 2-5 5-5-5Z" />
  </svg>
}

export function DepositDialog({ open, onOpenChange, address, insufficient = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; address?: string | null; insufficient?: boolean
}) {
  const validAddress = /^0x[0-9a-f]{40}$/i.test(address ?? '') && !/^0x0{40}$/i.test(address ?? '')
  const [qr, setQr] = useState<{ address: string; url: string } | null>(null)
  const [copyMessage, setCopyMessage] = useState('')
  const [qrError, setQrError] = useState(false)
  const qc = useQueryClient()
  useEffect(() => {
    let active = true
    setQr(null)
    setCopyMessage('')
    setQrError(false)
    if (open && validAddress && address) {
      QRCode.toDataURL(address, { width: 240, margin: 4, errorCorrectionLevel: 'M' })
        .then(url => { if (active) setQr({ address, url }) })
        .catch(() => { if (active) setQrError(true) })
    }
    return () => { active = false }
  }, [open, address, validAddress])
  const balance = useQuery<{ usdc: string; transfersEnabled?: boolean }>({
    queryKey: ['wallet-balance', address],
    enabled: open && validAddress,
    queryFn: async () => {
      const response = await fetch('/api/wallet/balance', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      const body = await response.json()
      if (!response.ok || body.data?.smartWallet?.toLowerCase() !== address?.toLowerCase()) throw new Error('Balance unavailable')
      return body.data
    },
    retry: false,
    refetchInterval: open ? 15_000 : false,
  })
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto gap-3 sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add USDC</DialogTitle>
        <DialogDescription>{insufficient ? 'Your USDC balance is too low for this message. Add funds, then retry.' : 'Fund your account wallet to pay for chats.'}</DialogDescription>
      </DialogHeader>
      <Tabs.Root defaultValue="wallet">
        <Tabs.List className="flex rounded-lg bg-secondary p-1" aria-label="Funding method">
          <div className="flex flex-1 items-center rounded-md has-[[data-active]]:bg-background">
            <Tabs.Tab value="wallet" className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-sm"><Wallet className="h-4 w-4" />Wallet</Tabs.Tab>
            <DepositHelp label="Wallet transfer help"><p>In your external wallet, select native USDC on Base. Scan this address QR code or paste the address to transfer.</p><p>Current x402 chat payments only require USDC, not ETH. Other transfers may require ETH or gas sponsorship.</p><p>Refresh your balance after funds arrive, then retry your message. Funding does not automatically charge you or remove payment trial restrictions.</p></DepositHelp>
          </div>
          <div className="flex flex-1 items-center rounded-md has-[[data-active]]:bg-background">
            <Tabs.Tab value="binance" className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-sm"><BinanceIcon />Binance</Tabs.Tab>
            <DepositHelp label="Binance transfer help"><p>In Binance, select Withdraw / Send → USDC → On-chain → Base, then paste this address. Check Binance for current fees, minimums and network availability.</p><p>This is a wallet address QR code, not a Binance Pay code. Use the scanner in the on-chain withdrawal address field, or copy the address.</p><p>Binance Pay is not required. If Base withdrawals are unavailable, do not select another network.</p></DepositHelp>
          </div>
        </Tabs.List>
        <Tabs.Panel value="wallet" />
        <Tabs.Panel value="binance" className="pt-2 text-xs text-muted-foreground">Copy the address for a Binance on-chain withdrawal. Do not use Binance Pay scanning.</Tabs.Panel>
      </Tabs.Root>
      <div className="rounded-lg bg-secondary p-3 text-sm">Network: <strong>Base mainnet</strong> · Asset: <strong>USDC</strong><p className="mt-1 text-xs text-muted-foreground">Select Base and native USDC on the sending platform, not another network or USDbC. We recommend receiving more than 1 USDC. {balance.data?.transfersEnabled === false ? 'Withdrawals in this app are currently unavailable.' : 'Withdrawals depend on availability, limits and cooldowns. The receiving wallet must support Base USDC.'}</p></div>
      {validAddress ? <>
        <div className="mx-auto flex h-44 w-44 max-w-full items-center justify-center rounded-xl bg-white">
          {qr && qr.address === address ? <img src={qr.url} width={176} height={176} alt="Your wallet receiving address QR code" /> : <span className="text-xs text-black">{qrError ? 'QR unavailable. Copy the address.' : 'Generating QR code…'}</span>}
        </div>
        <div><p className="text-xs text-muted-foreground mb-1">Your receiving address</p><p className="break-all rounded-lg bg-secondary p-3 font-mono text-xs select-all">{address}</p></div>
        <button type="button" className="rounded-xl bg-primary py-2.5 text-white" onClick={async () => {
          try { await navigator.clipboard.writeText(address!); setCopyMessage('Address copied') }
          catch { setCopyMessage('Copy failed. Select and copy the address above.') }
        }}>Copy wallet address</button>
        {copyMessage && <p role="status" className="text-xs">{copyMessage}</p>}
        <div className="flex items-center justify-between gap-2 text-sm"><span>{balance.isError ? 'Balance unavailable. Try refreshing.' : balance.data ? `Balance: ${balance.data.usdc} USDC` : 'Loading balance…'}</span><button type="button" disabled={balance.isFetching} className="shrink-0 text-primary disabled:opacity-50" onClick={() => void qc.invalidateQueries({ queryKey: ['wallet-balance'] })}>{balance.isFetching ? 'Loading…' : 'Refresh balance'}</button></div>
      </> : <p role="status" className="text-sm">Your wallet is not ready. Finish signing in, then try again.</p>}
    </DialogContent>
  </Dialog>
}
