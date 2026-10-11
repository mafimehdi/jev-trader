export const MARKOUT_HORIZONS = [1, 5, 20] as const;

export interface AnalysisOptions {
  /** Forward-return horizon used to score model probabilities. Default: 100 blocks. */
  modelHorizonBlocks?: number;
  /** Maximum number of blocks beyond a requested markout target that an observed sample may be. */
  maxForwardGapBlocks?: number;
}

export type FillSource = "live" | "simulated" | "unclassified";

export interface FillObservation {
  block: number;
  ts: number | null;
  side: "buy" | "sell";
  size: number;
  price: number;
  orderId: number | null;
  txHash: string | null;
  simulated: boolean | null;
}

interface EntryCaptureMetric {
  samples: number;
  fillsWithoutSameBlockMid: number;
  sizeMon: number;
  totalUsd: number;
  meanUsdPerMon: number | null;
  meanBps: number | null;
}

interface DecisionSample { probabilitiesBuy: number | null; late: boolean }
interface QuoteSample {
  status: string | null;
  gasMon: number | null;
  orderId: number | null;
  txHash: string | null;
}
interface BlockSample {
  block: number;
  ts: number | null;
  mid: number;
  /** `late` block events reuse the previous book read and are not fresh midpoint observations. */
  staleMid: boolean;
  decision: DecisionSample | null;
  quote: QuoteSample | null;
  totalsGasMon: number | null;
}
interface QuoteUpdate extends QuoteSample { block: number; ts: number | null }

export interface MarkoutMetric {
  horizonBlocks: number;
  samples: number;
  sizeMon: number;
  totalUsd: number;
  /** Size-weighted markout per MON. Negative values indicate adverse selection for the maker. */
  meanUsdPerMon: number | null;
  /** Size-weighted price markout relative to the fill price. */
  meanBps: number | null;
  negativeShare: number | null;
  meanObservedHorizonBlocks: number | null;
}

export interface MeasureReport {
  files: string[];
  recordsRead: number;
  malformedLines: number;
  blocks: {
    count: number;
    freshMidSamples: number;
    staleMidSamples: number;
    first: number | null;
    last: number | null;
    coveragePct: number | null;
    lastReportedGasMon: number | null;
  };
  activity: {
    quoteAttempts: number;
    confirmedLivePlacements: number;
    simulatedPlacements: number;
    quoteUpdates: number;
    quoteStatusCounts: Record<string, number>;
    fillEvents: number;
    liveFillEvents: number;
    simulatedFillEvents: number;
    unclassifiedFillEvents: number;
    blocksWithFills: number;
    filledOrders: number;
    fillSizeMon: number;
    fillsPerQuoteAttempt: number | null;
    fillsPerObservedBlock: number | null;
    filledOrdersPerPlacement: number | null;
  };
  economics: {
    gasMon: number;
    gasUsd: number;
    gasQuotes: number;
    gasUsdQuotes: number;
    simulatedGasMon: number;
    receiptGasMon: number;
    estimatedGasMon: number;
    gasMonPerFill: number | null;
    gasUsdPerFill: number | null;
    gasMonPerFilledOrder: number | null;
    entryMidSpreadCapture: EntryCaptureMetric;
    entryMidSpreadCaptureBySource: Record<FillSource, EntryCaptureMetric>;
  };
  markouts: MarkoutMetric[];
  markoutsBySource: Record<FillSource, MarkoutMetric[]>;
  model: {
    horizonBlocks: number;
    samples: number;
    pearsonIc: number | null;
    spearmanIc: number | null;
    meanForwardReturnBps: number | null;
    upRate: number | null;
    directionalAccuracy: number | null;
    brierScore: number | null;
  };
  notes: string[];
}

interface ParsedLog {
  blocks: BlockSample[];
  fills: FillObservation[];
  quoteUpdates: QuoteUpdate[];
  recordsRead: number;
  malformedLines: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const n = finite(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseDecision(value: unknown): DecisionSample | null {
  const decision = object(value);
  if (!decision) return null;
  const probabilities = object(decision.probabilities);
  const pBuy = finite(probabilities?.buy);
  return {
    probabilitiesBuy: pBuy !== null && pBuy >= 0 && pBuy <= 1 ? pBuy : null,
    late: decision.late === true,
  };
}

function parseQuote(value: unknown): QuoteSample | null {
  const quote = object(value);
  if (!quote) return null;
  return {
    status: stringOrNull(quote.status),
    gasMon: finite(quote.gasMon),
    orderId: integer(quote.orderId),
    txHash: stringOrNull(quote.txHash),
  };
}

function parseFill(block: number, ts: number | null, value: unknown): FillObservation | null {
  const fill = object(value);
  if (!fill || (fill.side !== "buy" && fill.side !== "sell")) return null;
  const size = finite(fill.size), price = finite(fill.price);
  if (size === null || size <= 0 || price === null || price <= 0) return null;
  return {
    block,
    ts,
    side: fill.side,
    size,
    price,
    orderId: integer(fill.orderId),
    txHash: stringOrNull(fill.txHash),
    simulated: typeof fill.simulated === "boolean" ? fill.simulated : null,
  };
}

function parseLog(contents: readonly string[]): ParsedLog {
  const blocksByNumber = new Map<number, BlockSample>();
  const legacyFillsByBlock = new Map<number, FillObservation>();
  const typedFills: FillObservation[] = [];
  const quoteUpdatesByKey = new Map<string, QuoteUpdate>();
  let recordsRead = 0;
  let malformedLines = 0;

  for (const content of contents) {
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
        recordsRead++;
      } catch {
        malformedLines++;
        continue;
      }
      const record = object(raw);
      if (!record) continue;

      const kind = stringOrNull(record.type);
      const recordBlock = integer(record.block);
      const recordTs = finite(record.ts);
      if (kind === "fill") {
        if (recordBlock !== null) {
          const fill = parseFill(recordBlock, recordTs, record.fill);
          if (fill) typedFills.push(fill);
        }
        continue;
      }
      if (kind === "quote") {
        const quote = parseQuote(record.quote);
        if (recordBlock !== null && quote) {
          const key = quote.txHash
            ? quote.txHash.toLowerCase()
            : `${recordBlock}:${quote.status ?? ""}:${quote.orderId ?? ""}`;
          quoteUpdatesByKey.set(key, { ...quote, block: recordBlock, ts: recordTs });
        }
        continue;
      }

      // Block events were historically written as raw objects without a `type` field.
      const block = recordBlock;
      const mid = finite(record.mid);
      if (block === null || mid === null || mid <= 0) continue;
      const decision = parseDecision(record.decision);
      const sample: BlockSample = {
        block,
        ts: recordTs,
        mid,
        staleMid: decision?.late === true,
        decision,
        quote: parseQuote(record.quote),
        totalsGasMon: finite(object(record.totals)?.gasMon),
      };
      const previous = blocksByNumber.get(block);
      if (!previous) {
        blocksByNumber.set(block, sample);
      } else {
        const newer = (sample.ts ?? -Infinity) >= (previous.ts ?? -Infinity) ? sample : previous;
        const older = newer === sample ? previous : sample;
        blocksByNumber.set(block, {
          ...older,
          ...newer,
          decision: newer.decision ?? older.decision,
          quote: newer.quote ?? older.quote,
          totalsGasMon: newer.totalsGasMon ?? older.totalsGasMon,
        });
      }
      const legacyFill = parseFill(block, recordTs, record.fill);
      if (legacyFill) legacyFillsByBlock.set(block, legacyFill);
    }
  }

  const typedFillBlocks = new Set(typedFills.map((fill) => fill.block));
  const fills = typedFills.concat(
    [...legacyFillsByBlock.values()].filter((fill) => !typedFillBlocks.has(fill.block)),
  ).sort((a, b) => a.block - b.block || (a.ts ?? 0) - (b.ts ?? 0));

  return {
    blocks: [...blocksByNumber.values()].sort((a, b) => a.block - b.block),
    fills,
    quoteUpdates: [...quoteUpdatesByKey.values()].sort((a, b) => a.block - b.block),
    recordsRead,
    malformedLines,
  };
}

function round(value: number, decimals = 6): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function lowerBound(blocks: readonly BlockSample[], target: number): number {
  let lo = 0, hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid]!.block < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function futureSample(
  blocks: readonly BlockSample[],
  startBlock: number,
  horizon: number,
  maxGap: number,
): { sample: BlockSample; observedBlocks: number } | null {
  const target = startBlock + horizon;
  let index = lowerBound(blocks, target);
  while (index < blocks.length && blocks[index]!.staleMid) index++;
  const sample = blocks[index];
  if (!sample || sample.block - target > maxGap) return null;
  return { sample, observedBlocks: sample.block - startBlock };
}

function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX, dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

function ranks(values: readonly number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.value === sorted[start]!.value) end++;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) out[sorted[i]!.index] = averageRank;
    start = end;
  }
  return out;
}

function fillSource(fill: FillObservation): FillSource {
  return fill.simulated === true ? "simulated" : fill.simulated === false ? "live" : "unclassified";
}

function groupFills(fills: readonly FillObservation[]): Record<FillSource, FillObservation[]> {
  const groups: Record<FillSource, FillObservation[]> = { live: [], simulated: [], unclassified: [] };
  for (const fill of fills) groups[fillSource(fill)].push(fill);
  return groups;
}

function summarizeEntryCapture(
  fills: readonly FillObservation[],
  blocksByNumber: ReadonlyMap<number, BlockSample>,
): EntryCaptureMetric {
  let samples = 0, fillsWithoutSameBlockMid = 0, sizeMon = 0, totalUsd = 0, weightedBps = 0;
  for (const fill of fills) {
    const atFill = blocksByNumber.get(fill.block);
    if (!atFill || atFill.staleMid) { fillsWithoutSameBlockMid++; continue; }
    const sign = fill.side === "buy" ? 1 : -1;
    const perMon = sign * (atFill.mid - fill.price);
    samples++;
    sizeMon += fill.size;
    totalUsd += perMon * fill.size;
    weightedBps += (perMon / atFill.mid) * 10_000 * fill.size;
  }
  return {
    samples,
    fillsWithoutSameBlockMid,
    sizeMon: round(sizeMon),
    totalUsd: round(totalUsd),
    meanUsdPerMon: sizeMon ? round(totalUsd / sizeMon) : null,
    meanBps: sizeMon ? round(weightedBps / sizeMon, 4) : null,
  };
}

function summarizeMarkout(
  fills: readonly FillObservation[],
  blocks: readonly BlockSample[],
  horizon: number,
  maxGap: number,
): MarkoutMetric {
  let samples = 0, sizeMon = 0, totalUsd = 0, weightedBps = 0, negative = 0, observedBlocks = 0;
  for (const fill of fills) {
    const forward = futureSample(blocks, fill.block, horizon, maxGap);
    if (!forward) continue;
    const sign = fill.side === "buy" ? 1 : -1;
    const perMon = sign * (forward.sample.mid - fill.price);
    samples++;
    sizeMon += fill.size;
    totalUsd += perMon * fill.size;
    weightedBps += (perMon / fill.price) * 10_000 * fill.size;
    if (perMon < 0) negative++;
    observedBlocks += forward.observedBlocks;
  }
  return {
    horizonBlocks: horizon,
    samples,
    sizeMon: round(sizeMon),
    totalUsd: round(totalUsd),
    meanUsdPerMon: sizeMon > 0 ? round(totalUsd / sizeMon) : null,
    meanBps: sizeMon > 0 ? round(weightedBps / sizeMon, 4) : null,
    negativeShare: samples > 0 ? round(negative / samples, 4) : null,
    meanObservedHorizonBlocks: samples > 0 ? round(observedBlocks / samples, 2) : null,
  };
}

function summarizeModel(
  blocks: readonly BlockSample[],
  horizon: number,
  maxGap: number,
): MeasureReport["model"] {
  const probabilities: number[] = [];
  const returnsBps: number[] = [];
  const outcomes: number[] = [];
  for (const block of blocks) {
    const decision = block.decision;
    const pBuy = decision?.probabilitiesBuy;
    if (!decision || decision.late || pBuy === null || pBuy === undefined) continue;
    const forward = futureSample(blocks, block.block, horizon, maxGap);
    if (!forward) continue;
    const ret = ((forward.sample.mid - block.mid) / block.mid) * 10_000;
    probabilities.push(pBuy);
    returnsBps.push(ret);
    outcomes.push(ret > 0 ? 1 : 0);
  }
  if (!probabilities.length) {
    return {
      horizonBlocks: horizon, samples: 0, pearsonIc: null, spearmanIc: null,
      meanForwardReturnBps: null, upRate: null, directionalAccuracy: null, brierScore: null,
    };
  }
  let brier = 0, right = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const error = probabilities[i]! - outcomes[i]!;
    brier += error * error;
    if ((probabilities[i]! >= 0.5) === (outcomes[i] === 1)) right++;
  }
  return {
    horizonBlocks: horizon,
    samples: probabilities.length,
    pearsonIc: correlation(probabilities, returnsBps),
    spearmanIc: correlation(ranks(probabilities), ranks(returnsBps)),
    meanForwardReturnBps: round(returnsBps.reduce((sum, value) => sum + value, 0) / returnsBps.length, 4),
    upRate: round(outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length, 4),
    directionalAccuracy: round(right / probabilities.length, 4),
    brierScore: round(brier / probabilities.length, 6),
  };
}

/** Analyze raw block-event lines plus typed `fill` and `quote` lifecycle records. */
export function analyzeEventContents(
  contents: readonly string[],
  options: AnalysisOptions = {},
  files: string[] = [],
): MeasureReport {
  const modelHorizon = options.modelHorizonBlocks ?? 100;
  const maxGap = options.maxForwardGapBlocks ?? 2;
  if (!Number.isInteger(modelHorizon) || modelHorizon < 1) throw new Error("modelHorizonBlocks must be a positive integer");
  if (!Number.isInteger(maxGap) || maxGap < 0) throw new Error("maxForwardGapBlocks must be a non-negative integer");

  const parsed = parseLog(contents);
  const blocks = parsed.blocks;
  const fills = parsed.fills;
  const quoteIntents = blocks.filter((block) => block.quote !== null);
  const quoteUpdates = parsed.quoteUpdates;
  const quoteStatusCounts: Record<string, number> = {};
  for (const quote of quoteUpdates) {
    if (quote.status) quoteStatusCounts[quote.status] = (quoteStatusCounts[quote.status] ?? 0) + 1;
  }

  const quoteUpdateByHash = new Map(quoteUpdates.flatMap((quote) => quote.txHash ? [[quote.txHash.toLowerCase(), quote] as const] : []));
  let gasMon = 0, gasUsd = 0, gasQuotes = 0, gasUsdQuotes = 0;
  let simulatedGasMon = 0, receiptGasMon = 0, estimatedGasMon = 0;
  for (const block of blocks) {
    const quote = block.quote;
    if (!quote || quote.gasMon === null || quote.gasMon < 0) continue;
    const update = quote.txHash ? quoteUpdateByHash.get(quote.txHash.toLowerCase()) : undefined;
    const hasReceiptCost = (update?.status === "placed" || update?.status === "reverted") && update.gasMon !== null;
    const cost = hasReceiptCost ? update.gasMon! : quote.gasMon;
    if (quote.status === "sim") simulatedGasMon += cost;
    else if (hasReceiptCost || quote.status === "placed" || quote.status === "reverted") receiptGasMon += cost;
    else estimatedGasMon += cost;
    gasMon += cost;
    gasQuotes++;
    const mid = quotePriceMid(blocks, block.block);
    if (mid !== null) {
      gasUsd += cost * mid;
      gasUsdQuotes++;
    }
  }

  const blockByNumber = new Map(blocks.map((block) => [block.block, block]));
  const fillGroups = groupFills(fills);
  const entryMidSpreadCapture = summarizeEntryCapture(fills, blockByNumber);
  const entryMidSpreadCaptureBySource: Record<FillSource, EntryCaptureMetric> = {
    live: summarizeEntryCapture(fillGroups.live, blockByNumber),
    simulated: summarizeEntryCapture(fillGroups.simulated, blockByNumber),
    unclassified: summarizeEntryCapture(fillGroups.unclassified, blockByNumber),
  };
  const markoutsBySource: Record<FillSource, MarkoutMetric[]> = {
    live: MARKOUT_HORIZONS.map((horizon) => summarizeMarkout(fillGroups.live, blocks, horizon, maxGap)),
    simulated: MARKOUT_HORIZONS.map((horizon) => summarizeMarkout(fillGroups.simulated, blocks, horizon, maxGap)),
    unclassified: MARKOUT_HORIZONS.map((horizon) => summarizeMarkout(fillGroups.unclassified, blocks, horizon, maxGap)),
  };

  const filledOrders = new Set(fills.flatMap((fill) => fill.orderId === null ? [] : [fill.orderId])).size;
  const fillBlocks = new Set(fills.map((fill) => fill.block)).size;
  const confirmedLivePlacements = quoteUpdates.filter((quote) => quote.status === "placed").length;
  const simulatedPlacements = quoteIntents.filter((block) => block.quote?.status === "sim").length;
  const trackedPlacements = confirmedLivePlacements + simulatedPlacements;
  const lastBlock = blocks.at(-1);
  const firstBlock = blocks[0];
  const span = firstBlock && lastBlock ? lastBlock.block - firstBlock.block + 1 : 0;
  const freshMidSamples = blocks.filter((block) => !block.staleMid).length;
  const staleMidSamples = blocks.length - freshMidSamples;
  const model = summarizeModel(blocks, modelHorizon, maxGap);
  const notes: string[] = [];
  if (!fills.length) notes.push("No durable fill records found. Older logs may not have persisted asynchronous fills; zero here does not prove there were no fills.");
  if (fillGroups.simulated.length) notes.push("Simulated fills are counterfactual: the dry-run matcher does not reconstruct queue priority or displacement. Keep them separate from live fills.");
  if (fillGroups.unclassified.length) notes.push("Some legacy fill records lack a simulated flag and could not be classified as live or simulated.");
  if (!quoteUpdates.length) notes.push("No quote-receipt lifecycle records found. Confirmed live placement counts may be incomplete for older logs.");
  if (fills.length && !gasQuotes) notes.push("No quote gas records found in this retained log window; per-fill gas is unavailable, not zero.");
  if (simulatedGasMon > 0) notes.push("Simulated gas is a modelled cost for dry-run quotes, not gas paid on chain.");
  if (estimatedGasMon > 0) notes.push("Some gas is estimated from the send quote because no successful/reverted receipt cost was recorded.");
  if (gasQuotes < quoteIntents.length) notes.push("Some quote intents have no recorded gasMon value; gas totals include only quotes with a recorded cost.");
  if (fills.length > 0 && fills.length < 30) notes.push("Fewer than 30 fill events are present; mark-out averages are highly sample-sensitive.");
  if (model.samples > 0 && model.samples < 100) notes.push("Fewer than 100 model observations are present; IC is highly sample-sensitive.");
  if (parsed.malformedLines) notes.push(`${parsed.malformedLines} malformed JSON line(s) were skipped.`);
  if (staleMidSamples) notes.push(`${staleMidSamples} late block midpoint sample(s) were excluded because they reuse the previous book read.`);
  if (!model.samples) notes.push("No eligible model decisions had a usable forward sample at the selected horizon.");
  if (fills.length && !entryMidSpreadCapture.samples) notes.push("Fill-time midpoint capture could not be computed because no fill block had a fresh matching midpoint sample.");

  return {
    files,
    recordsRead: parsed.recordsRead,
    malformedLines: parsed.malformedLines,
    blocks: {
      count: blocks.length,
      freshMidSamples,
      staleMidSamples,
      first: firstBlock?.block ?? null,
      last: lastBlock?.block ?? null,
      coveragePct: span > 0 ? round(freshMidSamples / span * 100, 2) : null,
      lastReportedGasMon: lastBlock?.totalsGasMon === null || lastBlock?.totalsGasMon === undefined
        ? null : round(lastBlock.totalsGasMon),
    },
    activity: {
      quoteAttempts: quoteIntents.length,
      confirmedLivePlacements,
      simulatedPlacements,
      quoteUpdates: quoteUpdates.length,
      quoteStatusCounts,
      fillEvents: fills.length,
      liveFillEvents: fillGroups.live.length,
      simulatedFillEvents: fillGroups.simulated.length,
      unclassifiedFillEvents: fillGroups.unclassified.length,
      blocksWithFills: fillBlocks,
      filledOrders,
      fillSizeMon: round(fills.reduce((sum, fill) => sum + fill.size, 0)),
      fillsPerQuoteAttempt: quoteIntents.length ? round(fills.length / quoteIntents.length, 6) : null,
      fillsPerObservedBlock: blocks.length ? round(fills.length / blocks.length, 6) : null,
      filledOrdersPerPlacement: trackedPlacements ? round(filledOrders / trackedPlacements, 6) : null,
    },
    economics: {
      gasMon: round(gasMon),
      gasUsd: round(gasUsd),
      gasQuotes,
      gasUsdQuotes,
      simulatedGasMon: round(simulatedGasMon),
      receiptGasMon: round(receiptGasMon),
      estimatedGasMon: round(estimatedGasMon),
      gasMonPerFill: gasQuotes && fills.length ? round(gasMon / fills.length) : null,
      gasUsdPerFill: gasUsdQuotes && fills.length ? round(gasUsd / fills.length) : null,
      gasMonPerFilledOrder: gasQuotes && filledOrders ? round(gasMon / filledOrders) : null,
      entryMidSpreadCapture,
      entryMidSpreadCaptureBySource,
    },
    markouts: MARKOUT_HORIZONS.map((horizon) => summarizeMarkout(fills, blocks, horizon, maxGap)),
    markoutsBySource,
    model,
    notes,
  };
}

function quotePriceMid(blocks: readonly BlockSample[], block: number): number | null {
  const index = lowerBound(blocks, block);
  if (blocks[index]?.block === block && !blocks[index]!.staleMid) return blocks[index]!.mid;
  let i = index - 1;
  while (i >= 0 && blocks[i]!.staleMid) i--;
  return i >= 0 ? blocks[i]!.mid : null;
}
