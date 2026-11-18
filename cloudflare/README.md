# ORYN liquidation bot (Cloudflare Worker)

Keeps the pool's prices fresh and liquidates unhealthy loans, on a one-minute cron with several checks per run.

Every check does two things:

1. **Prices.** It reads the live Chainlink feeds on Arc mainnet and, when one is newer than the Arc Testnet mirror, copies it over with Chainlink's original timestamp.
2. **Liquidations.** It finds wallets that borrowed (from the pool's Borrow events, read incrementally from the deploy block), asks the pool for each wallet's health, and for any below 1 it simulates and sends `liquidate`. The contract has the final say: it re-checks health and price freshness and reverts if either fails.

## Setup

```bash
bunx wrangler login
bunx wrangler kv namespace create STATE        # paste the printed id into cloudflare/wrangler.toml
bunx wrangler secret put RELAYER_PRIVATE_KEY --config cloudflare/wrangler.toml     # the mirror feeds' updater
bunx wrangler secret put LIQUIDATOR_PRIVATE_KEY --config cloudflare/wrangler.toml  # separate wallet, holds tokens to repay
bunx wrangler secret put ADMIN_TOKEN --config cloudflare/wrangler.toml             # optional, for POST /run
bun run bot:deploy
```

- Fund the liquidator wallet with test USDC, EURC and/or cirBTC. It repays debt in the asset the borrower owes and receives collateral at the liquidation bonus.
- The bot starts in **dry run** (`DRY_RUN = "1"`): prices are relayed, but liquidations are only simulated and logged. Set it to `"0"` in `wrangler.toml` and redeploy to go live.
- Use testnet keys with small balances only. Never commit keys.

## Endpoints

- `GET /status` public, read-only: last run, loans watched, liquidations, recent actions.
- `GET /health`
- `POST /run` with `Authorization: Bearer <ADMIN_TOKEN>` triggers a run now.

Set `VITE_BOT_URL` in the app to your Worker URL to show this on Analytics > Risk.

## Notes

- Free Workers plans limit requests per run. `TICKS_PER_RUN` defaults to 3 (a check every `TICK_MS` = 15 s). A paid plan allows more.
- Local test: `bun run bot:dev`, then call the scheduled handler as Wrangler describes.
