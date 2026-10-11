import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogResponse } from "./event-export";

const secret = "a-long-test-export-secret";

function withLogs(run: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-event-export-"));
    try {
      writeFileSync(join(dir, "events.jsonl"), "{\"block\":1}\n");
      writeFileSync(join(dir, "events.jsonl.1"), "{\"block\":0}\n");
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const request = (url = "http://localhost/export/events", authorization?: string, method = "GET") =>
  new Request(url, { method, headers: authorization ? { authorization } : undefined });

describe("authenticated event-log export", () => {
  test("is disabled with a not-found response when no secret is configured", withLogs(async (dir) => {
    const response = await eventLogResponse(request(), undefined, dir);
    expect(response.status).toBe(404);
  }));

  test("rejects missing or incorrect bearer credentials", withLogs(async (dir) => {
    expect((await eventLogResponse(request(), secret, dir)).status).toBe(401);
    expect((await eventLogResponse(request("http://localhost/export/events", "Bearer wrong"), secret, dir)).status).toBe(401);
    expect((await eventLogResponse(request("http://localhost/export/events", secret), secret, dir)).status).toBe(401);
  }));

  test("streams only the selected current or previous JSONL file", withLogs(async (dir) => {
    const current = await eventLogResponse(request("http://localhost/export/events", `Bearer ${secret}`), secret, dir);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toContain("application/x-ndjson");
    expect(current.headers.get("content-disposition")).toContain("events.jsonl\"");
    expect(await current.text()).toBe("{\"block\":1}\n");

    const previous = await eventLogResponse(request(`http://localhost/export/events?part=previous`, `Bearer ${secret}`), secret, dir);
    expect(previous.status).toBe(200);
    expect(previous.headers.get("content-disposition")).toContain("events.jsonl.1\"");
    expect(await previous.text()).toBe("{\"block\":0}\n");
  }));

  test("does not allow path selection outside the two rotated log names", withLogs(async (dir) => {
    const invalid = await eventLogResponse(request(`http://localhost/export/events?part=../../.env`, `Bearer ${secret}`), secret, dir);
    expect(invalid.status).toBe(400);
    const absent = await eventLogResponse(request(`http://localhost/export/events?part=previously`, `Bearer ${secret}`), secret, dir);
    expect(absent.status).toBe(400);
  }));

  test("requires GET and reports a missing allowed segment", withLogs(async (dir) => {
    const method = await eventLogResponse(request("http://localhost/export/events", `Bearer ${secret}`, "POST"), secret, dir);
    expect(method.status).toBe(405);
    rmSync(join(dir, "events.jsonl.1"));
    const missing = await eventLogResponse(request("http://localhost/export/events?part=previous", `Bearer ${secret}`), secret, dir);
    expect(missing.status).toBe(404);
  }));
});
