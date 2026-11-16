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
- Assistant: type "send 5 USDC to 0x...", "swap 10 USDC to EURC" or "bridge 20 USDC from Ethereum to Arc". The assistant drafts the action, checks it against limits you set (max per action, daily total, allowed tokens and networks, slippage, saved recipients), and nothing moves until you confirm in your wallet. With an AI key it also understands free-form requests; without one, plain commands still work.
- Agent wallet: a separate wallet (managed by Circle) that the assistant spends from with no wallet popups, for sends and swaps. You fund it from your wallet, set limits that the server enforces, pause it, and withdraw back to your wallet at any time. Bridging still asks you to confirm in your own wallet. Testnet only, and only fund it with small amounts.

Prices for USDC, EURC and cirBTC come from Chainlink feeds, not from the market owner, and borrowing and liquidations pause if a price goes stale. Arc Testnet has no Chainlink feeds yet, so on testnet the Arc mainnet Chainlink prices are copied onto testnet feeds by a relay script. This is a testnet demo and should not be used with real funds.

## Tech stack

- React, Vite, TypeScript, Tailwind CSS
- wagmi, viem, Privy (Google sign-in, embedded wallets and external wallets)
- Circle App Kit (swap and bridge)
- Serverless API (`api/`) for the Assistant and the agent wallet, with a local Bun server for development
- Circle developer-controlled wallets and Upstash Redis for the agent wallet
- Solidity and Foundry for the market contract in `contracts/`

## Deploying to Vercel

The `api/` folder runs as Vercel serverless functions. For the agent wallet, add these in your Vercel project settings (they are read at runtime, so the values in `vercel.json` are not enough):
`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `VITE_PRIVY_APP_ID`, `VITE_LENDING_POOL_ADDRESS`, `VITE_EURC_ADDRESS`, `VITE_CIRBTC_ADDRESS`, and a Redis database from the Upstash integration (it adds the `KV_REST_API_*` variables). Add an AI key to understand free-form requests. Without Redis the agent wallet stays off.

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev
```

Other scripts:

```bash
bun run server           # start the assistant's AI server (needed for free-form requests)
bun run check            # lint and typecheck
bun run contracts:build  # compile the contract
bun run contracts:test   # run contract tests (needs forge-std: git clone https://github.com/foundry-rs/forge-std lib/forge-std)
bun run relay:price      # copy the latest Chainlink prices onto the testnet feeds (add -- --watch to keep it running)
```

### Environment variables

- `VITE_LENDING_POOL_ADDRESS`: address of the deployed market contract on Arc Testnet.
- `VITE_EURC_ADDRESS`: address of the EURC token on Arc Testnet.
- `VITE_CIRBTC_ADDRESS`: address of the cirBTC token on Arc Testnet.
- `VITE_EURC_PRICE_FEED_ADDRESS`, `VITE_USDC_PRICE_FEED_ADDRESS`, `VITE_BTC_PRICE_FEED_ADDRESS`: the testnet price feeds the market reads. Only used by the relay script.
- `RELAYER_PRIVATE_KEY`: private key of the account allowed to update those feeds. Only used by the relay script. Keep it secret and never commit it.
- `VITE_PRIVY_APP_ID`: your Privy app ID. Required for sign-in. Enable Google as a login method in the Privy dashboard and add your app's origin to its allowed origins.
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`: optional. Turns on free-form requests in the Assistant. Server only, keep it secret and never prefix it with `VITE_`.
- `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`: required for the agent wallet. Server only. Back up the entity secret and its recovery file, because losing both means losing access to every wallet it controls.
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`): the Redis database the agent wallet needs on Vercel. Locally a file under `.agent-data/` is used instead.
- `AI_PROVIDER` (`groq` or `gemini`) and `AI_API_KEY`: optional shortcut for a free-tier provider.
- `AI_BASE_URL` and `AI_API_KEY`: optional. Use any OpenAI-compatible service instead, such as a free-tier provider or a local Ollama. Set `AI_MODEL` to match.
- `AI_MODEL`: optional model name for the AI provider you chose.
- `AI_SERVER_PORT`: optional port for the AI server (default 3001). The app reaches it through `/api` in development.
- `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS`: optional outside Arc Studio. Only used by backend code, which this app does not have.
