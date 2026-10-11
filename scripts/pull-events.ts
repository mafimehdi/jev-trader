import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join, resolve } from "node:path";

interface Options { url: string; out: string; help: boolean }

function parseArgs(args: string[]): Options {
  const options: Options = { url: process.env.EVENT_EXPORT_URL ?? "", out: "data", help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--url" || arg === "-u") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a service URL`);
      options.url = value;
    } else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--out" || arg === "-o") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a directory`);
      options.out = value;
    } else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !options.url) throw new Error("provide --url or EVENT_EXPORT_URL");
  return options;
}

function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

function loadKnownLines(archivePath: string): Set<string> {
  if (!existsSync(archivePath)) return new Set();
  const bytes = readFileSync(archivePath);
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeLength = lastNewline + 1;
  if (completeLength !== bytes.length) truncateSync(archivePath, Math.max(completeLength, 0));
  const content = bytes.subarray(0, Math.max(completeLength, 0)).toString("utf8");
  return new Set(content.split("\n").filter(Boolean).map(hashLine));
}

function printHelp() {
  console.log(`Usage: bun run scripts/pull-events.ts --url SERVICE_URL [options]

Downloads the authenticated current and rotated event logs, then adds only unseen,
complete JSONL records to <out>/events-archive.jsonl. Re-running is idempotent.

Options:
  -u, --url URL   Service origin (or set EVENT_EXPORT_URL).
  -o, --out DIR   Local output directory. Default: ./data.
  -h, --help      Show this help.

Authentication is read only from EVENT_EXPORT_TOKEN; it is never accepted on the command line.

Example:
  EVENT_EXPORT_TOKEN=... bun run pull-events -- --url https://your-service.example`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const token = process.env.EVENT_EXPORT_TOKEN;
  if (!token) throw new Error("EVENT_EXPORT_TOKEN is required in the local environment");

  const service = new URL(options.url);
  if (service.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(service.hostname)) {
    console.warn("Warning: sending EVENT_EXPORT_TOKEN over plain HTTP; use HTTPS outside local testing.");
  }
  const endpoint = new URL("/export/events", service);
  const outputDir = resolve(options.out);
  mkdirSync(outputDir, { recursive: true });
  const archivePath = join(outputDir, "events-archive.jsonl");
  const seen = loadKnownLines(archivePath);

  let downloaded = 0;
  let appended = 0;
  let duplicates = 0;
  let malformed = 0;
  let partialTail = 0;
  const newLines: string[] = [];

  // Fetch the rotated segment first so newly discovered lines are appended in block order.
  for (const part of ["previous", "current"] as const) {
    const url = new URL(endpoint);
    url.searchParams.set("part", part);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/x-ndjson" },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (part === "previous" && response.status === 404) continue;
    if (!response.ok) throw new Error(`${part} log download failed: HTTP ${response.status}`);

    const body = await response.text();
    const lastNewline = body.lastIndexOf("\n");
    if (lastNewline < 0) {
      if (body.length) partialTail++;
      continue;
    }
    if (lastNewline !== body.length - 1) partialTail++;
    const complete = body.slice(0, lastNewline + 1);
    for (let line of complete.split("\n")) {
      if (!line) continue;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      downloaded++;
      try { JSON.parse(line); } catch { malformed++; continue; }
      const digest = hashLine(line);
      if (seen.has(digest)) { duplicates++; continue; }
      seen.add(digest);
      newLines.push(line);
      appended++;
    }
  }

  if (newLines.length) appendFileSync(archivePath, `${newLines.join("\n")}\n`, "utf8");
  const sizeBytes = existsSync(archivePath) ? statSync(archivePath).size : 0;
  console.log(`Downloaded ${downloaded} complete records; appended ${appended}; already archived ${duplicates}; malformed skipped ${malformed}; incomplete tails skipped ${partialTail}.`);
  console.log(`Archive: ${archivePath} (${sizeBytes} bytes)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Event pull failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
