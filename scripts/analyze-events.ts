import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { analyzeEventContents, type MeasureReport } from "../src/measure";

interface CliOptions {
  input: string;
  modelHorizonBlocks: number;
  maxForwardGapBlocks: number;
  json: boolean;
  help: boolean;
}

function integerArg(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${flag} must be an integer`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    input: "data",
    modelHorizonBlocks: 100,
    maxForwardGapBlocks: 2,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--input" || arg === "-i") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      options.input = value;
    } else if (arg.startsWith("--input=")) options.input = arg.slice("--input=".length);
    else if (arg === "--horizon") {
      const value = args[++i];
      if (!value) throw new Error("--horizon requires a block count");
      options.modelHorizonBlocks = integerArg("--horizon", value);
    } else if (arg.startsWith("--horizon=")) options.modelHorizonBlocks = integerArg("--horizon", arg.slice("--horizon=".length));
    else if (arg === "--max-gap") {
      const value = args[++i];
      if (!value) throw new Error("--max-gap requires a block count");
      options.maxForwardGapBlocks = integerArg("--max-gap", value);
    } else if (arg.startsWith("--max-gap=")) options.maxForwardGapBlocks = integerArg("--max-gap", arg.slice("--max-gap=".length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && options.modelHorizonBlocks < 1) throw new Error("--horizon must be at least 1");
  if (!options.help && options.maxForwardGapBlocks < 0) throw new Error("--max-gap cannot be negative");
  return options;
}

function inputFiles(input: string): string[] {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`input path does not exist: ${path}`);
  const info = statSync(path);
  if (info.isDirectory()) {
    const files = [join(path, "events.jsonl.1"), join(path, "events.jsonl")]
      .filter((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (!files.length) throw new Error(`no events.jsonl or events.jsonl.1 found in ${path}`);
    return files;
  }
  if (!info.isFile()) throw new Error(`input is not a regular file: ${path}`);
  if (basename(path) === "events.jsonl" && existsSync(`${path}.1`)) return [`${path}.1`, path];
  return [path];
}

function help() {
  console.log(`Usage: bun run scripts/analyze-events.ts [options]

Options:
  -i, --input PATH   Event file or data directory. Defaults to ./data and reads both
                     events.jsonl.1 and events.jsonl when present.
      --horizon N    Forward-return horizon for model IC, in blocks. Default: 100.
      --max-gap N    Maximum observed-block overshoot beyond each target. Default: 2.
      --json         Print the complete report as JSON.
  -h, --help         Show this help.

Examples:
  bun run measure
  bun run measure -- --input ./data --horizon 100 --max-gap 2
  bun run measure -- --input ./data/events.jsonl --json`);
}

function n(value: number | null, decimals = 6): string {
  return value === null ? "n/a" : value.toFixed(decimals);
}

function reportText(report: MeasureReport): string {
  const lines = [
    "Jev Trader event measurements",
    `Sources: ${report.files.join(", ")}`,
    `Parsed records: ${report.recordsRead}; malformed lines: ${report.malformedLines}`,
    `Blocks: ${report.blocks.count} (${report.blocks.first ?? "n/a"}..${report.blocks.last ?? "n/a"}); fresh mid samples: ${report.blocks.freshMidSamples}; reused late samples: ${report.blocks.staleMidSamples}; coverage: ${n(report.blocks.coveragePct, 2)}%`,
    `Quotes: ${report.activity.quoteAttempts} attempts; ${report.activity.confirmedLivePlacements} confirmed live placements; ${report.activity.simulatedPlacements} simulated placements`,
    `Fills: ${report.activity.fillEvents} events across ${report.activity.blocksWithFills} blocks; live ${report.activity.liveFillEvents}, simulated ${report.activity.simulatedFillEvents}, unclassified ${report.activity.unclassifiedFillEvents}; ${n(report.activity.fillSizeMon, 2)} MON; ${n(report.activity.fillsPerQuoteAttempt, 6)} events per quote attempt`,
    `Unique filled orders: ${report.activity.filledOrders}; filled orders per tracked placement: ${n(report.activity.filledOrdersPerPlacement, 4)}`,
    `Recorded gas: ${n(report.economics.gasMon, 6)} MON; ${n(report.economics.gasUsd, 6)} USD; simulated ${n(report.economics.simulatedGasMon, 6)} MON; receipt-derived ${n(report.economics.receiptGasMon, 6)} MON; estimated ${n(report.economics.estimatedGasMon, 6)} MON`,
    `Average recorded gas per fill event: ${n(report.economics.gasMonPerFill, 6)} MON; ${n(report.economics.gasUsdPerFill, 6)} USD`,
    `Fill vs same-block mid, all sources: ${report.economics.entryMidSpreadCapture.samples} fills; ${n(report.economics.entryMidSpreadCapture.totalUsd, 6)} USD total; live ${n(report.economics.entryMidSpreadCaptureBySource.live.totalUsd, 6)} USD; simulated ${n(report.economics.entryMidSpreadCaptureBySource.simulated.totalUsd, 6)} USD; unclassified ${n(report.economics.entryMidSpreadCaptureBySource.unclassified.totalUsd, 6)} USD`,
    "Mark-outs from fill price (negative means adverse selection):",
  ];
  for (let i = 0; i < report.markouts.length; i++) {
    const markout = report.markouts[i]!;
    const live = report.markoutsBySource.live[i]!;
    const simulated = report.markoutsBySource.simulated[i]!;
    const unclassified = report.markoutsBySource.unclassified[i]!;
    lines.push(`  +${markout.horizonBlocks} blocks: all ${markout.samples} samples, ${n(markout.meanBps, 4)} bps, ${n(markout.negativeShare, 4)} negative; live ${live.samples} (${n(live.meanBps, 4)} bps, ${n(live.negativeShare, 4)} negative); simulated ${simulated.samples} (${n(simulated.meanBps, 4)} bps, ${n(simulated.negativeShare, 4)} negative); unclassified ${unclassified.samples} (${n(unclassified.meanBps, 4)} bps, ${n(unclassified.negativeShare, 4)} negative)`);
  }
  lines.push(
    `Model IC at +${report.model.horizonBlocks} blocks: ${report.model.samples} samples; Pearson ${n(report.model.pearsonIc, 4)}; Spearman ${n(report.model.spearmanIc, 4)}; mean return ${n(report.model.meanForwardReturnBps, 4)} bps; up rate ${n(report.model.upRate, 4)}; directional accuracy ${n(report.model.directionalAccuracy, 4)}; Brier ${n(report.model.brierScore, 6)}`,
    `Last block snapshot gas total: ${n(report.blocks.lastReportedGasMon, 6)} MON`,
    "",
    "Interpretation: entry-mid capture is not closed-trade PnL. Mark-outs are size-weighted maker-side value changes. Model IC uses overlapping forward returns and is descriptive, not proof of predictive edge.",
  );
  if (report.notes.length) {
    lines.push("Notes:");
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  const files = inputFiles(options.input);
  const report = analyzeEventContents(
    files.map((file) => readFileSync(file, "utf8")),
    { modelHorizonBlocks: options.modelHorizonBlocks, maxForwardGapBlocks: options.maxForwardGapBlocks },
    files,
  );
  console.log(options.json ? JSON.stringify(report, null, 2) : reportText(report));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`Measurement failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
