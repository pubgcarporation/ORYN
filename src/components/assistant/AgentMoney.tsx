import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { erc20Abi, type Address } from 'viem'
import { useAccount, useReadContracts, useWriteContract } from 'wagmi'
import { ARC_ID, ASSET_LIST, ASSETS, fmtAsset, parseInput, type AssetSymbol } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { useTx } from '@/hooks/useTx'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { TokenBadge } from '@/components/ui'
import type { ChatResult } from '@/agent/useAgentWallet'

interface Props {
  agent: Address
  owner: Address
  onWithdraw: (token: string, amount: string) => Promise<ChatResult | undefined>
}

function TokenAmount({ token, setToken, amount, setAmount, label }: { token: AssetSymbol; setToken: (t: AssetSymbol) => void; amount: string; setAmount: (v: string) => void; label: string }) {
  return (
    <div className="flex gap-2">
      <input
        inputMode="decimal"
        className="field inner num min-h-11 min-w-0 flex-1 px-3 text-sm"
        placeholder="0.00"
        aria-label={`${label} amount`}
        value={amount}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '')
          if (/^\d*\.?\d*$/.test(v)) setAmount(v)
        }}
      />
      <select className="field inner min-h-11 px-2 text-sm" aria-label={`${label} token`} value={token} onChange={(e) => setToken(e.target.value as AssetSymbol)}>
        {ASSET_LIST.map((a) => (
          <option key={a.symbol} value={a.symbol}>
            {a.symbol}
          </option>
        ))}
      </select>
    </div>
  )
}

/** What the agent wallet holds, plus moving money in from your wallet and back out to it. */
export function AgentMoney({ agent, owner, onWithdraw }: Props) {
  const { address: me } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const [fundToken, setFundToken] = useState<AssetSymbol>('USDC')
  const [fundAmount, setFundAmount] = useState('')
  const [outToken, setOutToken] = useState<AssetSymbol>('USDC')
  const [outAmount, setOutAmount] = useState('')
  const [outBusy, setOutBusy] = useState(false)
  const [outNote, setOutNote] = useState<string | null>(null)

  const { data, refetch } = useReadContracts({
    contracts: ASSET_LIST.map((a) => ({ address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [agent], chainId: ARC_ID })),
    query: { refetchInterval: 8000 },
  })
  const balance = (s: AssetSymbol): bigint => {
    const v = data?.[ASSET_LIST.findIndex((a) => a.symbol === s)]?.result
    return typeof v === 'bigint' ? v : 0n
  }

  const tx = useTx(() => {
    setFundAmount('')
    void refetch()
  })
  const raw = parseInput(fundAmount, ASSETS[fundToken].decimals)
  const canFund = Boolean(me) && raw !== undefined && !tx.busy

  const fund = () => {
    if (raw === undefined) return
    void tx.run([
      {
        label: `Send ${fundAmount} ${fundToken} to the agent wallet`,
        send: () => writeContractAsync({ address: ASSETS[fundToken].address, abi: erc20Abi, functionName: 'transfer', args: [agent, raw], chainId: ARC_ID }),
      },
    ])
  }

  const withdraw = async () => {
    setOutBusy(true)
    setOutNote(null)
    const res = await onWithdraw(outToken, outAmount)
    setOutBusy(false)
    if (res) {
      setOutNote(res.reply)
      setOutAmount('')
      void refetch()
    }
  }
  const outRaw = parseInput(outAmount, ASSETS[outToken].decimals)
  const outMax = spendable(balance(outToken), outToken === 'USDC')

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {ASSET_LIST.map((a) => (
          <div key={a.symbol} className="inner p-3">
            <div className="flex items-center gap-1.5">
              <TokenBadge symbol={a.symbol} size={16} />
              <span className="label">{a.symbol}</span>
            </div>
            <div className="num mt-1.5 truncate text-base font-semibold">{fmtAsset(balance(a.symbol), a.symbol)}</div>
          </div>
        ))}
      </div>

      <div>
        <p className="label mb-2">Fund from your wallet</p>
        <TokenAmount token={fundToken} setToken={setFundToken} amount={fundAmount} setAmount={setFundAmount} label="Fund" />
        <button className="btn-primary mt-2 w-full" disabled={!canFund} onClick={fund}>
          {tx.busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> {tx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
            </>
          ) : (
            'Send to agent wallet'
          )}
        </button>
        {tx.phase === 'success' && tx.hash && (
          <a href={buildTxExplorerUrl(ARC_ID, tx.hash)} target="_blank" rel="noopener noreferrer" className="mt-1.5 block text-xs font-semibold" style={{ color: 'var(--success)' }}>
            Sent. View transaction
          </a>
        )}
        {tx.phase === 'error' && (
          <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--danger)' }}>
            {tx.error}
          </p>
        )}
        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--subtle)' }}>
          USDC also pays network fees on Arc, so keep some in the agent wallet. Fund small testnet amounts only.
        </p>
      </div>

      <div>
        <p className="label mb-2">Withdraw to your wallet</p>
        <TokenAmount token={outToken} setToken={setOutToken} amount={outAmount} setAmount={setOutAmount} label="Withdraw" />
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--subtle)' }}>
          <span className="num truncate">To {owner.slice(0, 6)}...{owner.slice(-4)}</span>
          <button className="chip" disabled={outMax === 0n} onClick={() => setOutAmount(fmtAsset(outMax, outToken, ASSETS[outToken].decimals).replace(/,/g, ''))}>
            Max
          </button>
        </div>
        <button className="btn-ghost mt-2 w-full" disabled={outRaw === undefined || outBusy} onClick={() => void withdraw()}>
          {outBusy && <Loader2 className="size-4 animate-spin" />} Withdraw
        </button>
        {outNote && (
          <p role="status" className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            {outNote}
          </p>
        )}
      </div>
    </div>
  )
}
