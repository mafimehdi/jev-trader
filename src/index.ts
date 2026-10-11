import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";

const market = new Market();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
  () => trader.health(),
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.paused) return; // the transition itself was logged; do not repeat it every block
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);
// OrderCreated prices are in pricePrecision units, unlike Trade's 1e18.
trader.attachTradeFeed(log10(market.params.sizePrecision), log10(market.params.pricePrecision));

console.log(`jev-trader · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN (gas is simulated and charged)" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
if (config.gasBudgetMon > 0) console.log(`gas budget ${config.gasBudgetMon} MON (live only); model deadline ${config.modelTimeoutMs}ms`);
startBlockFeed((block) => trader.onBlock(block));
