import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { config } from "./config";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import { ModelTimeout, type Action, type Decision, type Model, type TradeState } from "./model";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
  /** Why quoting is stopped ("model", "reverts", "stuck nonce", "gas budget"), or null while quoting. */
  paused: string | null;
}

/** What the dashboard needs to tell "running" from "wedged". Served at GET / and in the SSE snapshot. */
export interface Health {
  paused: string | null;
  lastBlock: number;
  lastBlockTs: number;
  /** ms since the last block, -1 when no block has been seen at all. */
  ageMs: number;
  stale: boolean;
  consecutiveFailures: number;
  consecutiveReverts: number;
  inflight: number;
  pendingStuck: boolean;
  /** Lost receipts whose order id never surfaced. An upper bound: a lost tx may never have landed. */
  unknownOrphans: number;
  gasMon: number;
  gasBudgetMon: number;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

interface Resting { side: Side; price: number; size: number; block: number }

/**
 * Every block: read the book, ask the model buy or sell, and post one post-only limit order on
 * that side (`quoteInsideTicks` inside the touch), cancelling whatever we had resting. One request
 * in flight; a block that arrives while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 *
 * Nothing here is allowed to run unattended into a hole. Four guards stop quoting and say why:
 * a model that keeps missing its deadline (`paused: "model"`, clears itself on the next answer), a
 * run of reverted/lost quotes (`paused: "reverts"`, retried by one probe tx every `probeBlocks`), a
 * stuck nonce (`paused: "stuck nonce"`, clears when the pending txs land) and the gas budget
 * (`paused: "gas budget"`, live only, final). `health()` reports all of it.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Orders we know are resting on the book (live: from receipts or the log feed; dry run: last block's simulated order). */
  private orders = new Map<number, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
  private paused: string | null = null;
  private failures = 0; // consecutive model failures
  private reverts = 0; // consecutive reverted/lost quotes
  private probeAt = 0; // while paused by reverts, the next block a probe send is allowed
  private unknownOrphans = 0; // lost receipts whose order id never surfaced
  private unknownReceiptHashes = new Set<string>();
  private lastBlock = 0;
  private lastBlockTs = 0;
  private logBytes = 0;
  private fillSequence = 0;

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
    try { this.logBytes = statSync("data/events.jsonl").size; } catch { this.logBytes = 0; }
  }

  /**
   * Call once the market params are known. Without it `trades` in the state is all zeros and no fills
   * are ever seen. `orderPriceDec` is the OrderCreated unit (log10 pricePrecision), not Trade's 1e18.
   */
  attachTradeFeed(sizeDec: number, orderPriceDec?: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, orderPriceDec, maker: this.market.address });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.lastBlock = block;
    this.lastBlockTs = Date.now();
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + margin + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints, fills and our order lifecycle

      let decision: Decision;
      try {
        decision = await this.model.decide(this.buildState(block, book));
      } catch (e) {
        // A model that hangs or errors must never wedge the loop (and never leave `busy` set): count it,
        // emit the block with no quote, and keep asking every block until it answers again.
        this.failures++;
        const why = (e as Error).message || String(e);
        if (this.failures >= config.modelFailureLimit && this.paused !== "model") {
          this.paused = "model";
          console.warn(`block ${block}: ${this.failures} model calls in a row failed (${why}); quoting paused, decisions keep retrying`);
        } else if (e instanceof ModelTimeout) {
          console.warn(`block ${block}: model late (${why})`);
        } else {
          console.error(`block ${block}: model failed (${why})`);
        }
        this.emit(block, book, null, null, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
        return;
      }
      if (this.failures > 0) {
        this.failures = 0;
        if (this.paused === "model") { this.paused = null; console.log(`block ${block}: model recovered, quoting resumed`); }
      }

      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      const other: Side = wanted === "buy" ? "sell" : "buy";
      // The position cap (and, live, margin funds) can only pick the reducing side. The probabilities still show the model's call.
      const side: Side | null = this.allowed(wanted, book) ? wanted : this.allowed(other, book) ? other : null;
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;

      let quote: Quote | null = null;
      const gate = this.quoteGate(block);
      if (side && !gate) {
        decision.action = side;
        const cancel = [...this.orders.keys()].filter((id) => id > 0); // simulated orders have negative ids
        quote = await this.market.send(block, side, config.tradeSizeMon, book, cancel, side !== wanted);
        this.totals.quotes++;
        if (quote.status === "sim") {
          this.totals.gasMon += quote.gasMon; // a dry run still burns the gas a live send would
          this.orders.clear(); // the simulated cancel
          this.orders.set(--this.simId, { side, price: quote.price, size: quote.size, block });
        } else if (quote.txHash) {
          this.inflight.set(quote.txHash, quote);
        }
        if (this.paused === "reverts") { this.probeAt = block + config.probeBlocks; console.log(`block ${block}: probe tx sent while paused by reverts`); }
      }
      this.emit(block, book, decision, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Null when this block may send; otherwise the reason quoting is stopped. Ordered by how final the
   * reason is: gas budget (live only, done), reverts (probe now and then), stuck nonce (wait it out),
   * model (already handled before the quote is attempted).
   */
  private quoteGate(block: number): string | null {
    if (this.market.wallet && config.gasBudgetMon > 0 && this.totals.gasMon >= config.gasBudgetMon) {
      if (this.paused !== "gas budget") {
        this.paused = "gas budget";
        console.warn(`gas budget ${config.gasBudgetMon} MON reached at block ${block}: quoting stopped for good`);
      }
      return "gas budget";
    }
    const pendingAge = this.market.pendingAge(block);
    if (pendingAge >= config.pendingStuckBlocks) {
      if (this.paused !== "stuck nonce") {
        this.paused = "stuck nonce";
        console.warn(`block ${block}: oldest unconfirmed tx is ${pendingAge} blocks old; quoting paused until receipts resolve`);
      }
      return "stuck nonce";
    }
    if (this.paused === "reverts") return block >= this.probeAt ? null : "reverts";
    if (this.paused === "stuck nonce") { this.paused = null; console.log(`block ${block}: pending txs confirmed, quoting resumed`); }
    return this.paused;
  }

  /** Snapshot of the guards for GET / and the SSE snapshot. */
  health(): Health {
    const ageMs = this.lastBlockTs ? Date.now() - this.lastBlockTs : -1;
    return {
      paused: this.paused,
      lastBlock: this.lastBlock,
      lastBlockTs: this.lastBlockTs,
      ageMs,
      stale: ageMs < 0 || ageMs > config.staleMs,
      consecutiveFailures: this.failures,
      consecutiveReverts: this.reverts,
      inflight: this.inflight.size,
      pendingStuck: this.market.pendingAge(this.lastBlock) >= config.pendingStuckBlocks,
      unknownOrphans: this.unknownOrphans,
      gasMon: round(this.totals.gasMon, 6),
      gasBudgetMon: config.gasBudgetMon,
    };
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled }: QuoteResult) {
    if (quote.txHash) this.inflight.delete(quote.txHash);
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    for (const id of canceled) this.orders.delete(id);
    if (quote.txHash && quote.status !== "lost" && this.unknownReceiptHashes.delete(quote.txHash)) {
      this.unknownOrphans = Math.max(0, this.unknownOrphans - 1);
    }

    // Breaker: a run of reverted or lost quotes is not bad luck, it is the market telling us not to
    // send. Pause and retry with a single probe tx every `probeBlocks` instead of paying every block.
    if (quote.status === "placed") {
      this.reverts = 0;
      if (this.paused === "reverts") { this.paused = null; console.log(`block ${block}: a quote landed again, quoting resumed`); }
    } else if (quote.status === "reverted" || quote.status === "lost") {
      if (quote.status === "reverted") this.totals.reverted++;
      if (quote.status === "lost" && quote.txHash && !this.unknownReceiptHashes.has(quote.txHash)) {
        this.unknownReceiptHashes.add(quote.txHash);
        this.unknownOrphans++; // the order may exist on the book; the log feed will say so
      }
      this.reverts++;
      if (this.reverts >= config.revertLimit && this.paused !== "reverts") {
        this.paused = "reverts";
        this.probeAt = block + config.probeBlocks;
        console.warn(`block ${block}: ${this.reverts} quotes in a row reverted or lost; quoting paused, one probe every ${config.probeBlocks} blocks`);
      }
    }
    if (quote.status === "placed" && quote.orderId !== null) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    // The original block line records the send intent. This second record makes the eventual
    // receipt outcome durable for offline placement-rate and revert analysis.
    this.appendJournal("quote", block, { quote });
    this.onQuote(block, quote);
  }

  /**
   * After each trade-log poll: adopt and drop our own orders, then apply maker fills (live) or simulate
   * them against the new prints (dry run).
   */
  private harvest() {
    if (!this.trades) return;
    // Our order lifecycle first: an order whose receipt never arrived is on the book right now, and it
    // has to be cancelable (and counted toward the cap) before fills are matched against it.
    const own = this.trades.drainOwn();
    for (const o of own.created) {
      if (this.orders.has(o.orderId)) continue;
      this.orders.set(o.orderId, { side: o.side, price: o.price, size: o.size, block: o.block });
      if (this.unknownOrphans > 0) {
        const unresolvedHash = this.unknownReceiptHashes.values().next().value;
        if (unresolvedHash !== undefined) this.unknownReceiptHashes.delete(unresolvedHash);
        this.unknownOrphans--;
        console.warn(`block ${o.block}: adopted order ${o.orderId} (${o.side} ${o.size} @ ${o.price}); its receipt never arrived`);
      }
    }
    for (const id of own.canceled) this.orders.delete(id);

    const prints = this.trades.drainPrints();
    const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      const b = (f as Fill & { block: number }).block;
      // Persist each raw fill, not only the block-level UI aggregate. Two sides or multiple
      // partial fills can land in the same block and must all contribute to mark-outs.
      const { block: _block, ...fill } = f as Fill & { block: number };
      // Sequence prevents exact duplicate hashes when identical simulated fills share a timestamp.
      this.appendJournal("fill", b, { fill, sequence: ++this.fillSequence });
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs);
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const hit = o.side === "buy" ? p.side === "sell" && p.price <= o.price : p.side === "buy" && p.price >= o.price;
        if (!hit) continue;
        const size = Math.min(o.size, p.size);
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block: p.block });
      }
    }
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside margin funds? */
  private allowed(side: Side, book: Book) {
    const size = config.tradeSizeMon;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    // Kuru debits margin when an order is placed, so the balance already excludes what is resting.
    return side === "buy" ? this.market.margin.usdc >= size * book.ask : this.market.margin.mon >= size;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: "MON-USDC",
      block,
      horizonBlocks: H,
      blockMs: 300,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.fills++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      fill: null,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
      paused: this.paused,
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    this.appendEvent(event);
    this.onEvent(event, timing);
  }

  /** `data/events.jsonl` grows ~4 KB per block: rotate past the cap so a long run cannot fill the disk. */
  private appendEvent(event: BlockEvent) {
    this.appendRecord(event);
  }

  /** Durable lifecycle records supplement block snapshots because fills and receipts arrive later. */
  private appendJournal(type: "fill" | "quote", block: number, data: Record<string, unknown>) {
    this.appendRecord({ type, block, ts: Date.now(), ...data });
  }

  private appendRecord(record: unknown) {
    const line = JSON.stringify(record) + "\n";
    if (config.eventLogMaxBytes > 0 && this.logBytes + line.length > config.eventLogMaxBytes) {
      try { renameSync("data/events.jsonl", "data/events.jsonl.1"); } catch { /* first rotation, or a locked file: start over */ }
      this.logBytes = 0;
    }
    appendFileSync("data/events.jsonl", line);
    this.logBytes += line.length;
  }
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
