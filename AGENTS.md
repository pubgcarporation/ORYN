# ORYN

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

A three-asset (USDC, EURC and cirBTC) money market on Arc Testnet: earn, borrow, swap, bridge and positions pages. Supplies are collateral for borrowing. EURC/USD and USDC/USD prices come from Chainlink-compatible feeds (no owner price setter).

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, Privy
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## Share links

- Starter apps already ship `getShareBase`, `buildShareLink` and `installShareSync` in `src/lib/share.ts`; import them instead of rewriting them.
- Keep shareable state in the URL path or query, not in the `#fragment`.
- Never put a secret (private key, claim secret, seed phrase, session token, API key) in the URL path or query, encoded or not: every in-app path and query is mirrored to the visitor's studio.arc.io address bar and browser history and reaches servers. A bearer claim secret goes only in the `#fragment` appended to the share link (`` `${await buildShareLink('/claim')}#${secret}` ``) and is read from `location.hash` on load. A link to the app's own share URL shown inside the app must be copy-only or open in a new tab with `target="_blank" rel="noopener noreferrer"`.
- Build every link a user copies or sends with `buildShareLink()` from `src/lib/share.ts`.
- Keep the `installShareSync()` call in `src/main.tsx` when editing it; it keeps the Studio address bar in step with in-app navigation.
- Navigate inside the app with relative links.

## To Run

```bash
bun install
bun run dev
```


## Deployed contracts

- OrynPool (market) on Arc Testnet: `0x7123a2846d167e42489dc4496b3a3e6081117052` (current, deployed 2026-11-19 against new price feeds; deployed 2026-11-18 design with Aave V3 style receipt tokens: each asset has a transferable aToken named "aORYN <asset>" (aUSDC, aEURC, acirBTC; balance = scaled shares x supply index, so it grows without transactions) and a non-transferable debt token (dUSDC, dEURC, dcirBTC), created by the pool constructor as clones of one OrynToken implementation; read them with `aToken(asset)` and `debtToken(asset)`; moving aTokens is blocked when the sender would become undercollateralized. USDC aToken: read `aToken(asset)`. Aave V3 style liquidation: `liquidate(borrower, debtAsset, collateralAsset, repay, receiveSupplyShares)` and a close factor of 50%, or 100% when health is below 0.95; the 4-argument `liquidate` still works; three assets: USDC, EURC, cirBTC). Constructor: (owner, usdc, eurc, cirBtc, usdcUsdFeed, eurcUsdFeed, btcUsdFeed). cirBTC is `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` (8 decimals; no public faucet). All prices are read from AggregatorV3 feeds; borrow, liquidate and withdraw-with-debt revert when any feed is older than maxPriceAge (2 days default, one shared limit) or invalid. Owner is the shared platform deployer wallet.
  - Known open review items (not fixed): tiny positions (about 1 satoshi) can be impossible to liquidate; one shared price age limit for all three feeds.
  - Feeds on Arc Testnet are MirrorAggregator contracts (testnet has no Chainlink feeds): EURC/USD `0x8e6981aa888371715e7f047ad038c734f6da1208`, USDC/USD `0x4a4aa3ec89468e043515f299f6273c38f3eb4103`, BTC/USD `0xe4666036661a2ea0c5fce63ffa19bee9e9ae7374`. They relay the Arc mainnet Chainlink proxies (EURC/USD `0x361b95c10b76Ca3f35C686d423e43A951755Bf23`, USDC/USD `0x84EA90AC252Dc437031461836DB5164219147905`, BTC/USD `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De`) with the original Chainlink timestamps. Updater is the relayer wallet `0xEb11c28706C71aFFeC9926896f0647837Ae4e21b` (key is `RELAYER_PRIVATE_KEY` in `.env` and in Cloudflare as a secret; never print it). The older feeds (updater `0xdadb…949f`, key lost) are abandoned. Run `bun run relay:price -- --watch` to keep them fresh. For mainnet, pass the real Chainlink proxies to the pool constructor instead of mirrors.
  - Previous pools: `0xa60dd309bbd9ca90feed5deab2b27cb8d5cf2120` (aORYN tokens, old price feeds), `0x517b3339458c59b841a85f94cd85b6567278d539` (tokens named oUSDC etc.), `0x13d445dedb81cd4390a0295693bf7073e5c3d949` (dynamic close factor, balances kept in the pool, no tokens) and `0x84b8d4ba692aa57250c0bd99d8080529fd81825e` (fixed 50% close factor) are still on-chain and running; balances did not move. The contract test suite predates the receipt tokens and was not updated or run for them. Point `VITE_LENDING_POOL_ADDRESS` back at it to use it. Earlier pools (`0x0fbd3b837e062f1f4d8f70c7952b8384e4816ab3` and older) are unused.
  - Review notes for the current pool: the owner can change the shared price age instantly, the three price feeds are fixed at deploy with no fallback, and dust positions revert with ZeroSeizure by design (tests cover it).
- Frontend reads `VITE_LENDING_POOL_ADDRESS` and `VITE_EURC_ADDRESS` from `.env`.

## Auth and routing

- `src/providers.tsx` wraps the app in Privy (Google, embedded wallet, external wallets incl. WalletConnect). Without `VITE_PRIVY_APP_ID` it shows a setup notice.
- `src/auth/useAuth.ts` is the one place components call to sign in or out. Do not call Privy hooks elsewhere.
- Paths: `/` landing, `/app/{earn,borrow,swap,bridge,positions}`. Router is `src/lib/router.tsx` (no react-router).
- Privy dashboard needs the app's origin under allowed origins, and Google enabled as a login method.

## Mobile conventions

- Mobile first: bottom tab bar under 768px, bottom sheets for money actions (drag down to close), 44px minimum tap targets, 16px inputs (no iOS zoom), safe-area padding via `.safe-top` and `.safe-bottom`.
- Hover effects only apply on devices with a real hover pointer.
- Verified at 360, 390 and 768px widths: no horizontal overflow.
