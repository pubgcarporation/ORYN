# ORYN

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

A two-asset (USDC and EURC) money market on Arc Testnet: earn, borrow, swap, bridge and positions pages. Supplies are collateral for borrowing. The EURC/USD price is owner-set (testnet grade).

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

- OrynPool (market) on Arc Testnet: `0x475a06699235e3be4e22dabaa30f3d3aa4ef82fa`
  - Constructor order: (owner, usdc, eurc, initialEurUsdPrice). Owner is the shared platform deployer wallet, so owner-only calls (setEurcPrice, setRiskParams, pause) cannot be made from the user's wallet. maxPriceAge is 7 days; after that, borrowing and liquidation pause until the price is refreshed. Redeploy from the user's own wallet to control the oracle.
  - Earlier deployments of the same code under the old name are unused.
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
