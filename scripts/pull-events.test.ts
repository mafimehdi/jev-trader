import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const secret = "puller-test-secret";
const line = (block: number) => JSON.stringify({ type: "block", block });

async function runPull(url: string, outputDir: string): Promise<void> {
  const repoDir = resolve(import.meta.dir, "..");
  const script = fileURLToPath(new URL("./pull-events.ts", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, "run", script, "--url", url, "--out", outputDir],
    { cwd: repoDir, env: { PATH: process.env.PATH ?? "", EVENT_EXPORT_TOKEN: secret }, stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`pull-events exited ${status}: ${stdout}\n${stderr}`);
}

describe("event log puller", () => {
  test("deduplicates overlapping current/rotated snapshots and appends on later pulls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-pull-events-"));
    let current = `${line(1)}\n${line(2)}\n{\"block\":`; // trailing partial write is ignored
    const previous = `${line(0)}\n${line(1)}\n`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
        const part = new URL(request.url).searchParams.get("part");
        if (part === "previous") return new Response(previous, { headers: { "content-type": "application/x-ndjson" } });
        if (part === "current") return new Response(current, { headers: { "content-type": "application/x-ndjson" } });
        return new Response("bad request", { status: 400 });
      },
    });

    try {
      const output = join(dir, "archive");
      await runPull(server.url.origin, output);
      const archive = join(output, "events-archive.jsonl");
      expect(readFileSync(archive, "utf8").trim().split("\n").map((raw) => JSON.parse(raw).block)).toEqual([0, 1, 2]);

      current = `${line(2)}\n${line(3)}\n{\"block\":`; // overlap plus one new line
      await runPull(server.url.origin, output);
      expect(readFileSync(archive, "utf8").trim().split("\n").map((raw) => JSON.parse(raw).block)).toEqual([0, 1, 2, 3]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
