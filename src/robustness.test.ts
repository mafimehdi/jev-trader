/**
 * Guards that must hold before this bot is trusted with gas: the model deadline, the tightened gas
 * limit, the order-lifecycle decoders and the paused states. `bun test`.
 *
 * The trader writes `data/events.jsonl`, so these run in a temp cwd and never touch the repo's copy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { config } from "./config";
import type { Book, Market, QuoteResult } from "./market";
import { tightLimit } from "./market";
import { ModelTimeout, withDeadline, type Decision, type Model, type TradeState } from "./model";
import { Trader, type BlockEvent } from "./trader";
import {
  ORDER_CREATED_TOPIC0,
  ORDERS_CANCELED_TOPIC0,
  TRADE_TOPIC0,
  decodeOrderCreated,
  decodeOrdersCanceled,
} from "./trades";

const cwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "jev-trader-test-"));
beforeAll(() => process.chdir(scratch));
afterAll(() => { process.chdir(cwd); rmSync(scratch, { recursive: true, force: true }); });

const BOOK = {
  block: 1, bid: 0.02579, ask: 0.02584, mid: 0.025815, spreadBps: 19.4, imbalance: 0,
  levels: { bids: [], asks: [] }, depthBps: {},
} as unknown as Book;

const decision = (action: "buy" | "sell"): Decision => ({
  action, probabilities: { buy: action === "buy" ? 0.8 : 0.2, sell: action === "buy" ? 0.2 : 0.8, hold: 0 },
  upIn10: action === "buy" ? 0.8 : 0.2, latencyMs: 1, inputTokens: 10,
});

/** A model whose behaviour the test flips at will. */
class ScriptedModel implements Model {
  readonly name = "scripted";
  mode: "ok" | "throw" | "hang" = "ok";
  async decide(): Promise<Decision> {
    if (this.mode === "throw") throw new Error("boom");
    if (this.mode === "hang") await Bun.sleep(5_000);
    return decision("buy");
  }
}

/** A Market that never touches the network: every send is a dry-run quote. */
function fakeMarket(live = false, pendingAge: () => number = () => 0): Market {
  return {
    wallet: live ? { address: "0x1111111111111111111111111111111111111111" } : null,
    address: live ? "0x1111111111111111111111111111111111111111" : null,
    margin: { mon: 600, usdc: 20 },
    readBook: async () => BOOK,
    refresh: async () => {},
    pollPending: async () => [],
    pendingAge,
    send: async (_block: number, side: "buy" | "sell", size: number, _b: Book, cancel: number[], capped: boolean) =>
      ({ side, price: 0.0258, size, txHash: live ? "0xsent" : null, gasMon: 0.0357, cancel, status: live ? "sent" as const : "sim" as const, orderId: null, capped }),
  } as unknown as Market;
}

function traderWith(model: Model, events: BlockEvent[] = []): { trader: Trader; events: BlockEvent[] } {
  const trader = new Trader(fakeMarket(), model, (e) => events.push(e));
  return { trader, events };
}

describe("withDeadline", () => {
  test("rejects a model that misses its deadline", async () => {
    const slow: Model = { name: "slow", decide: async () => { await Bun.sleep(100); return decision("buy"); } };
    const guarded = withDeadline(slow, 10);
    await expect(guarded.decide({} as TradeState)).rejects.toBeInstanceOf(ModelTimeout);
  });

  test("passes a fast model through untouched", async () => {
    const model = new ScriptedModel();
    const guarded = withDeadline(model, 100);
    expect((await guarded.decide({} as TradeState)).action).toBe("buy");
    expect(guarded.name).toBe("scripted");
  });

  test("handles a model that throws synchronously", async () => {
    const model: Model = { name: "sync throw", decide: () => { throw new Error("sync boom"); } };
    await expect(withDeadline(model, 20).decide({} as TradeState)).rejects.toThrow("sync boom");
    await Bun.sleep(30);
    expect(true).toBe(true);
  });

  test("a call that lands after the timeout does not escape as an unhandled rejection", async () => {
    const slow: Model = { name: "slow", decide: async () => { await Bun.sleep(30); return decision("sell"); } };
    const guarded = withDeadline(slow, 5);
    await guarded.decide({} as TradeState).catch(() => {});
    await Bun.sleep(60); // let the loser settle: the process must still be alive here
    expect(true).toBe(true);
  });
});

describe("tightLimit", () => {
  test("falls back when no shape has been measured", () => {
    expect(tightLimit(new Map(), 1, 350_000)).toBe(350_000);
    expect(tightLimit(new Map(), 1, 350_000, 400_000)).toBe(400_000); // the floor wins
  });

  test("uses the exact shape once a receipt has measured it", () => {
    const used = new Map([[0, 282_000], [1, 310_000]]);
    expect(tightLimit(used, 1, 350_000)).toBe(Math.ceil(310_000 * 1.15)); // 356500, still under the old 427k
    expect(tightLimit(used, 0, 350_000, 282_000)).toBe(Math.ceil(282_000 * 1.15));
  });

  test("bootstraps an unseen shape from the nearest one, 45k per extra cancel", () => {
    expect(tightLimit(new Map([[0, 282_000]]), 1, 350_000)).toBe(Math.ceil((282_000 + 45_000) * 1.15));
    expect(tightLimit(new Map([[2, 380_000]]), 1, 350_000)).toBe(Math.ceil(380_000 * 1.15));
  });

  test("never drops below the measured place-only estimate", () => {
    expect(tightLimit(new Map([[2, 100_000]]), 2, 1000, 282_000)).toBe(282_000);
  });
});

describe("order lifecycle decoders", () => {
  const coder = ethers.utils.defaultAbiCoder;
  const me = "0x1111111111111111111111111111111111111111";
  const other = "0x2222222222222222222222222222222222222222";
  const log = (data: string, block = 0x10) => ({ blockNumber: "0x" + block.toString(16), logIndex: "0x0", transactionHash: "0xtx", topics: [ORDER_CREATED_TOPIC0], data });

  test("topic constants match the contract signatures", () => {
    expect(ORDER_CREATED_TOPIC0).toBe(ethers.utils.id("OrderCreated(uint40,address,uint96,uint32,bool)"));
    expect(ORDERS_CANCELED_TOPIC0).toBe(ethers.utils.id("OrdersCanceled(uint40[],address)"));
    expect(TRADE_TOPIC0).toBe(ethers.utils.id("Trade(uint40,address,bool,uint256,uint96,address,address,uint96)"));
  });

  test("decodes our own OrderCreated, price in pricePrecision units", () => {
    const data = coder.encode(["uint40", "address", "uint96", "uint32", "bool"], [42, me, "2000000000000", 258000, true]);
    const o = decodeOrderCreated(log(data), me, 10, 8);
    expect(o).not.toBeNull();
    expect(o!).toMatchObject({ block: 16, orderId: 42, size: 200, price: 0.00258000, side: "buy" });
  });

  test("ignores another wallet's OrderCreated", () => {
    const data = coder.encode(["uint40", "address", "uint96", "uint32", "bool"], [42, other, "2000000000000", 258000, true]);
    expect(decodeOrderCreated(log(data), me, 10, 8)).toBeNull();
    expect(decodeOrderCreated(log(data), null, 10, 8)).toBeNull(); // dry run: no wallet, nothing to adopt
  });

  test("decodes OrdersCanceled and drops the zeros batchUpdate pads with", () => {
    const data = coder.encode(["uint40[]", "address"], [[0, 7, 901], me]);
    expect(decodeOrdersCanceled({ ...log(data), topics: [ORDERS_CANCELED_TOPIC0] }, me)).toEqual([7, 901]);
  });

  test("ignores OrdersCanceled from another owner", () => {
    const data = coder.encode(["uint40[]", "address"], [[7], other]);
    expect(decodeOrdersCanceled({ ...log(data), topics: [ORDERS_CANCELED_TOPIC0] }, me)).toEqual([]);
  });
});

describe("Trader guards", () => {
  test("charges simulated gas on a dry run, so the dashboard cannot look free", async () => {
    const { trader, events } = traderWith(new ScriptedModel());
    await trader.onBlock(1);
    expect(events[0]!.quote?.status).toBe("sim");
    expect(trader.health().gasMon).toBeCloseTo(0.0357, 6);
    expect(events[0]!.totals.gasUsd).toBeGreaterThan(0);
  });

  test("a model that throws pauses quoting after the limit and resumes on its own", async () => {
    const model = new ScriptedModel();
    const { trader, events } = traderWith(model);
    model.mode = "throw";
    for (let i = 0; i < config.modelFailureLimit; i++) await trader.onBlock(i + 1);
    expect(trader.health().paused).toBe("model");
    expect(trader.health().consecutiveFailures).toBe(config.modelFailureLimit);
    expect(events.filter((e) => e.quote !== null)).toHaveLength(0);

    model.mode = "ok";
    await trader.onBlock(99);
    expect(trader.health().paused).toBeNull();
    expect(trader.health().consecutiveFailures).toBe(0);
    expect(events.at(-1)!.quote).not.toBeNull();
  });

  test("a hanging model cannot wedge the loop: the block finishes, late, with no quote", async () => {
    const model = new ScriptedModel();
    model.mode = "hang";
    const { trader, events } = traderWith(withDeadline(model, 20));
    const t0 = performance.now();
    await trader.onBlock(1);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(events).toHaveLength(1);
    expect(events[0]!.quote).toBeNull();
    expect(events[0]!.decision).toBeNull();
    expect(events[0]!.paused).toBeNull(); // one miss is late, not a pause
  });

  test("health reports staleness, not silence", async () => {
    const { trader } = traderWith(new ScriptedModel());
    expect(trader.health().stale).toBe(true); // no block seen yet
    await trader.onBlock(1);
    const h = trader.health();
    expect(h.stale).toBe(false);
    expect(h.lastBlock).toBe(1);
    expect(h.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("pauses on an unresolved nonce and resumes only after its receipt resolves", () => {
    const previousBudget = config.gasBudgetMon;
    config.gasBudgetMon = 0;
    let age = config.pendingStuckBlocks;
    const trader = new Trader(fakeMarket(true, () => age), new ScriptedModel(), () => {});
    const internal = trader as unknown as { quoteGate: (block: number) => string | null };
    try {
      expect(internal.quoteGate(100)).toBe("stuck nonce");
      expect(trader.health().paused).toBe("stuck nonce");
      expect(trader.health().pendingStuck).toBe(true);
      age = 0;
      expect(internal.quoteGate(101)).toBeNull();
      expect(trader.health().paused).toBeNull();
    } finally {
      config.gasBudgetMon = previousBudget;
    }
  });

  test("persists each asynchronous raw fill and the final quote receipt", async () => {
    const market = fakeMarket(true);
    const trader = new Trader(market, new ScriptedModel(), () => {});
    const internals = trader as unknown as {
      trades: {
        poll: () => Promise<void>;
        summary: () => { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: null; lastPrice: null; lastSide: null };
        recent: () => [];
        drainOwn: () => { created: []; canceled: [] };
        drainPrints: () => [];
        drainFills: () => { block: number; txHash: string; orderId: number; price: number; size: number; updatedSize: number; side: "buy" | "sell" }[];
      } | null;
      applyQuoteResult: (result: QuoteResult) => void;
    };
    internals.trades = {
      poll: async () => {},
      summary: () => ({ count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null }),
      recent: () => [],
      drainOwn: () => ({ created: [], canceled: [] }),
      drainPrints: () => [],
      drainFills: () => [
        { block: 1, txHash: "0xtaker", orderId: 42, price: 0.0258, size: 2, updatedSize: 0, side: "buy" },
        { block: 1, txHash: "0xtaker", orderId: 42, price: 0.0258, size: 2, updatedSize: 0, side: "buy" },
      ],
    };

    await trader.onBlock(1);
    await Bun.sleep(0); // allow the off-path log poll to harvest and append its fill
    internals.applyQuoteResult({
      block: 1,
      quote: { side: "buy", price: 0.0258, size: 200, txHash: "0xsent", gasMon: 0.0357, cancel: [], status: "placed", orderId: 42, capped: false },
      canceled: [],
    });
    const records = readFileSync("data/events.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const fillRecords = records.filter((record) => record.type === "fill" && record.block === 1 && record.fill.orderId === 42);
    expect(fillRecords).toHaveLength(2);
    expect(fillRecords.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records.some((record) => record.type === "quote" && record.block === 1 && record.quote.status === "placed")).toBe(true);
  });
});
