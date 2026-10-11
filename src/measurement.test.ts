import { describe, expect, test } from "bun:test";
import { analyzeEventContents } from "./measure";

function event(block: number, mid: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ block, ts: block * 300, mid, decision: null, quote: null, totals: { gasMon: 0 }, ...extra });
}

function fill(side: "buy" | "sell", size: number, price: number, orderId: number) {
  return { side, size, price, orderId, txHash: `0xtx${orderId}`, simulated: false };
}

describe("event measurement harness", () => {
  test("computes fill-mid capture, horizon mark-outs and quote gas without double-counting legacy fills", () => {
    const lines: string[] = [];
    for (let block = 100; block <= 120; block++) {
      const mid = block === 100 ? 100 : block === 101 ? 99 : block === 105 ? 101 : block === 120 ? 102 : 100;
      lines.push(event(block, mid, block === 100 ? {
        fill: fill("buy", 2, 99.5, 7), // legacy field plus typed record below must count once
        quote: { side: "buy", price: 99.5, size: 2, txHash: "0xsend", gasMon: 0.0357, status: "sent", orderId: null },
      } : {}));
    }
    lines.push(JSON.stringify({ type: "fill", block: 100, ts: 30_000, fill: fill("buy", 2, 99.5, 7) }));
    lines.push(JSON.stringify({ type: "quote", block: 100, ts: 30_100, quote: { status: "placed", gasMon: 0.04, orderId: 7, txHash: "0xsend" } }));

    const report = analyzeEventContents([lines.join("\n")], { modelHorizonBlocks: 10, maxForwardGapBlocks: 0 }, ["test.jsonl"]);
    expect(report.blocks.count).toBe(21);
    expect(report.activity.quoteAttempts).toBe(1);
    expect(report.activity.confirmedLivePlacements).toBe(1);
    expect(report.activity.fillEvents).toBe(1);
    expect(report.activity.fillSizeMon).toBe(2);
    expect(report.activity.fillsPerQuoteAttempt).toBe(1);
    expect(report.activity.filledOrdersPerPlacement).toBe(1);
    expect(report.economics.gasMon).toBeCloseTo(0.04, 6); // final receipt cost overrides the send estimate
    expect(report.economics.gasUsd).toBeCloseTo(4, 6);
    expect(report.economics.receiptGasMon).toBeCloseTo(0.04, 6);
    expect(report.economics.estimatedGasMon).toBe(0);
    expect(report.economics.gasMonPerFill).toBeCloseTo(0.04, 6);
    expect(report.economics.entryMidSpreadCapture.totalUsd).toBeCloseTo(1, 9);
    expect(report.economics.entryMidSpreadCapture.meanUsdPerMon).toBeCloseTo(0.5, 9);
    expect(report.markouts.map((m) => m.samples)).toEqual([1, 1, 1]);
    expect(report.markouts[0]!.totalUsd).toBeCloseTo(-1, 9);
    expect(report.markouts[1]!.totalUsd).toBeCloseTo(3, 9);
    expect(report.markouts[2]!.totalUsd).toBeCloseTo(5, 9);
    expect(report.markouts[0]!.negativeShare).toBe(1);
  });

  test("scores buy probability against the forward return with Pearson and rank IC", () => {
    const mids = new Map<number, number>([
      [3, 99], [6, 99.5], [9, 100.5], [12, 101],
    ]);
    const probabilities = new Map<number, number>([[1, 0.1], [4, 0.3], [7, 0.7], [10, 0.9]]);
    const lines: string[] = [];
    for (let block = 0; block <= 12; block++) {
      const mid = mids.get(block) ?? 100;
      const p = probabilities.get(block);
      lines.push(event(block, mid, p === undefined ? {} : {
        decision: { action: p >= 0.5 ? "buy" : "sell", probabilities: { buy: p, sell: 1 - p, hold: 0 }, late: false },
      }));
    }

    const report = analyzeEventContents([lines.join("\n")], { modelHorizonBlocks: 2, maxForwardGapBlocks: 0 });
    expect(report.model.samples).toBe(4);
    expect(report.model.pearsonIc).toBeGreaterThan(0.95);
    expect(report.model.spearmanIc).toBeCloseTo(1, 9);
    expect(report.model.meanForwardReturnBps).toBeCloseTo(0, 6);
    expect(report.model.upRate).toBe(0.5);
    expect(report.model.directionalAccuracy).toBe(1);
    expect(report.model.brierScore).toBeCloseTo(0.05, 6);
  });

  test("keeps live and counterfactual simulated fills separate", () => {
    const lines = [
      event(10, 100),
      event(11, 101),
      JSON.stringify({ type: "fill", block: 10, ts: 3_000, fill: { ...fill("buy", 1, 100.5, 1), simulated: false } }),
      JSON.stringify({ type: "fill", block: 10, ts: 3_001, fill: { ...fill("sell", 1, 100.5, 2), simulated: true } }),
    ];
    const report = analyzeEventContents(lines, { modelHorizonBlocks: 1, maxForwardGapBlocks: 0 });
    expect(report.activity.liveFillEvents).toBe(1);
    expect(report.activity.simulatedFillEvents).toBe(1);
    expect(report.markouts[0]!.totalUsd).toBeCloseTo(0, 9);
    expect(report.markoutsBySource.live[0]!.totalUsd).toBeCloseTo(0.5, 9);
    expect(report.markoutsBySource.simulated[0]!.totalUsd).toBeCloseTo(-0.5, 9);
    expect(report.notes.some((note) => note.includes("counterfactual"))).toBe(true);
  });

  test("skips late snapshots that reused the previous book read", () => {
    const lines = [
      event(100, 100, { decision: { probabilities: { buy: 0.8 }, late: false } }),
      event(101, 999, { decision: { probabilities: { buy: 0.1 }, late: true } }),
      event(102, 101),
      JSON.stringify({ type: "fill", block: 100, ts: 30_000, fill: fill("buy", 1, 100, 9) }),
    ];
    const report = analyzeEventContents(lines, { modelHorizonBlocks: 1, maxForwardGapBlocks: 1 });
    expect(report.blocks.freshMidSamples).toBe(2);
    expect(report.blocks.staleMidSamples).toBe(1);
    expect(report.blocks.coveragePct).toBeCloseTo(66.67, 2);
    expect(report.model.samples).toBe(1);
    expect(report.markouts[0]!.meanObservedHorizonBlocks).toBe(2);
    expect(report.notes.some((note) => note.includes("late block midpoint"))).toBe(true);
  });

  test("reports malformed lines and censors unavailable forward samples", () => {
    const report = analyzeEventContents([
      `not-json\n${event(10, 1, { decision: { probabilities: { buy: 0.8 }, late: false } })}`,
    ], { modelHorizonBlocks: 100, maxForwardGapBlocks: 0 });
    expect(report.recordsRead).toBe(1);
    expect(report.malformedLines).toBe(1);
    expect(report.model.samples).toBe(0);
    expect(report.notes.some((note) => note.includes("malformed JSON"))).toBe(true);
  });
});
