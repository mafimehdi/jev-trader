# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block posts a real post-only limit order on that side, one tick inside the touch, replacing the last one. Fills happen when a taker hits it, so the bot earns the spread instead of paying it. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

## Endpoints

Deployed (dry run, mock model): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, `health`, latest block event
- `GET /health` the guards alone: `paused`, `lastBlockTs`, `ageMs`, `stale`, inflight, unknown orphans, gas
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands
- `GET /export/events?part=current|previous` downloads `events.jsonl` or its one rotated predecessor; requires `Authorization: Bearer …` and returns 404 unless `EVENT_EXPORT_TOKEN` is configured

`health.stale` and `health.paused` are how "running" is told from "wedged": the transport can be up
(`ping` every 15 s) while no block is being decided, and the dashboard shows that as `stalled` instead
of live.

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order that block put on the book: a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything we had resting (`cancel`). `hold` appears only with `decision.late: true`, when the model missed the block and nothing was posted. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true` and `probabilities` still show the model's call. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The same applies to a dry run: a simulated quote is charged the gas a live send would burn, so the dashboard P&L is not flattered by a zero. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. Each block with fills gets its own SSE event, and `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and a real print crossing its price fills it (`simulated: true`), and it is charged the gas a live send would have burned.

## Guards

Nothing in the loop may hang or spend unattended, so every failure mode ends in a named pause rather
than a silent stall. `paused` is echoed on each block event and in `health`:

| `paused` | When | Back |
|---|---|---|
| `model` | `MODEL_FAILURE_LIMIT` model calls in a row failed; a timeout emits a late block and counts as a failure | by itself, on the next answered decision |
| `reverts` | `REVERT_LIMIT` consecutive reverted or lost quotes | one probe tx every `PROBE_BLOCKS`, until a quote lands |
| `stuck nonce` | a receipt is still missing after `PENDING_STUCK_BLOCKS`; the hash remains tracked | when the pending txs resolve |
| `gas budget` | live only; cumulative gas past `GAS_BUDGET_MON` | never, it is a hard stop |

Two more counters in `health`: `inflight` (sends without a receipt) and `unknownOrphans` (lost
receipts whose order id never surfaced; the log feed adopts such an order the moment it appears, and
the count drops). `data/events.jsonl` rotates past `EVENT_LOG_MAX_BYTES`.

`bun test` covers the deadline, the gas-limit maths, the log decoders, pause transitions and the measurement formulas.

## Offline measurement

Run the analysis locally against the event log. It reads both the current file and its one rotated predecessor when present:

    bun run measure
    bun run scripts/analyze-events.ts --input ./data --horizon 100 --max-gap 2
    bun run scripts/analyze-events.ts --input ./data --json

The report includes maker-side fill mark-outs at +1, +5 and +20 blocks, fill-time price versus the recorded midpoint, quote attempts and confirmed placements, gas per fill, and Pearson/Spearman information coefficients between `probabilities.buy` and the forward midpoint return. The model horizon defaults to 100 blocks. A forward sample uses the first recorded midpoint at or after the target block, only if it is within `--max-gap` (default 2 blocks). Late events that reuse a previous book read are excluded as midpoint samples.

The report splits live, simulated and unclassified fills. Simulated fills are counterfactual because the dry-run matcher does not reconstruct queue priority or displacement; do not treat them as realized executions. Gas totals use receipt-derived costs when available, fall back to the send estimate when unresolved, and label dry-run gas as simulated. The fill-time comparison is an immediate midpoint capture, not closed-trade P&L. A mark-out is `sign × (futureMid - fillPrice)`, with `sign=+1` for our buy and `-1` for our sell, then multiplied by fill size. Negative mark-out is adverse selection for the maker. IC samples overlap and are descriptive, not proof of a profitable edge.

Block snapshots are kept in their existing JSONL format. New runs also append typed `fill` records for every raw fill and typed `quote` records when receipts resolve, because fills and receipts arrive after the block snapshot was written. Older logs written before this instrumentation may have no durable fill records; a reported zero then means "not recorded", not necessarily "no fills". Server-side rotation deliberately remains bounded to `events.jsonl` and `events.jsonl.1`.

### Export and retain logs for local analysis

Set a strong `EVENT_EXPORT_TOKEN` in the service's deployment secrets. The authenticated export route stays disabled (404) while it is unset; the token is sent in the `Authorization` header, never in the URL. From a trusted local machine, make the same secret available as an environment variable and pull periodically (about every 30 minutes is a good starting interval):

    bun run pull-events -- --url https://your-service.example --out ./data

The puller fetches the current and rotated files, ignores an incomplete trailing JSONL line, and appends only unseen records to `./data/events-archive.jsonl`. Re-running is idempotent, so the local archive can outlive the server's bounded two-file rotation. Keep the token out of source control and use HTTPS outside local testing. Analyze the accumulated archive with:

    bun run measure -- --input ./data/events-archive.jsonl
    bun run measure -- --input ./data/events-archive.jsonl --json

No real service logs are included with the repository; conclusions require pulling the actual logs first.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded batchUpdate (cancel + post-only place), margin deposits, local nonce, async confirmation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, guards, position and P&L accounting
    src/measure.ts  offline event-log metrics: fills, mark-outs, gas and model IC
    src/event-export.ts authenticated, bounded export of the two server-side log files
    src/server.ts   Bun.serve: snapshot, health, history, SSE and event export
    scripts/analyze-events.ts  command-line event-log report
    scripts/pull-events.ts     idempotent local JSONL archive puller
    src/robustness.test.ts  deadline, gas limit, log decoders, pause transitions
    src/measurement.test.ts  event-log and measurement formulas

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips:
one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is measured off the hot path instead:
one estimate at startup, then the tightest limit per shape, x1.15, from the `gasUsed` in receipts we
have already seen), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price
lookup (static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK
