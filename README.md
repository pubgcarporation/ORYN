# ORYN

A stablecoin money market on Arc Testnet. Supply USDC, EURC or cirBTC (Circle's wrapped Bitcoin) to earn interest, borrow against your deposits, swap between the two, bridge USDC in from other test networks, and track your positions and health.

Built with [Arc Studio](https://studio.arc.io)

## What you can do

- Landing page at `/` with live market data, and the app at `/app/earn`, `/app/borrow`, `/app/swap`, `/app/bridge` and `/app/positions`.
- Sign in with Google (a wallet is created for you) or connect your own wallet, all from one sign-in window.
- Earn: deposit USDC, EURC or cirBTC and earn a variable rate. Deposits count as collateral.
- Borrow: borrow USDC, EURC or cirBTC against what you supplied, with a simulator that previews your health factor first.
- Swap: trade between USDC and EURC.
- Bridge: move USDC between Arc Testnet and Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia or Polygon Amoy.
- Positions: see what you supplied and owe, your borrow limit and your health factor.

Prices for USDC, EURC and cirBTC come from Chainlink feeds, not from the market owner, and borrowing and liquidations pause if a price goes stale. Arc Testnet has no Chainlink feeds yet, so on testnet the Arc mainnet Chainlink prices are copied onto testnet feeds by a relay script. This is a testnet demo and should not be used with real funds.

## Tech stack

- React, Vite, TypeScript, Tailwind CSS
- wagmi, viem, Privy (Google sign-in, embedded wallets and external wallets)
- Circle App Kit (swap and bridge)
- Solidity and Foundry for the market contract in `contracts/`

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev
```

Other scripts:

```bash
bun run check            # lint and typecheck
bun run contracts:build  # compile the contract
bun run contracts:test   # run contract tests
bun run relay:price      # copy the latest Chainlink prices onto the testnet feeds (add -- --watch to keep it running)
```

### Environment variables

- `VITE_LENDING_POOL_ADDRESS`: address of the deployed market contract on Arc Testnet.
- `VITE_EURC_ADDRESS`: address of the EURC token on Arc Testnet.
- `VITE_CIRBTC_ADDRESS`: address of the cirBTC token on Arc Testnet.
- `VITE_EURC_PRICE_FEED_ADDRESS`, `VITE_USDC_PRICE_FEED_ADDRESS`, `VITE_BTC_PRICE_FEED_ADDRESS`: the testnet price feeds the market reads. Only used by the relay script.
- `RELAYER_PRIVATE_KEY`: private key of the account allowed to update those feeds. Only used by the relay script. Keep it secret and never commit it.
- `VITE_PRIVY_APP_ID`: your Privy app ID. Required for sign-in. Enable Google as a login method in the Privy dashboard and add your app's origin to its allowed origins.
- `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS`: optional outside Arc Studio. Only used by backend code, which this app does not have.
