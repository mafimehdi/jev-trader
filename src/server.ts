import { config } from "./config";
import type { Fill, Quote } from "./market";
import type { BlockEvent, Health } from "./trader";

interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/**
 * GET / snapshot · GET /history recent blocks · GET /events SSE stream
 * (`snapshot`, `block`, `quote`, `fill`, `ping`)
 *
 * `/` and the stream's `snapshot` both carry `health`: paused reason, last block age and stale flag,
 * so a wedged loop cannot look live. `ping` is keep-alive only and must not be read as liveness.
 */
export function startServer(meta: Meta, history: () => BlockEvent[], health: () => Health) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  Bun.serve({
    port: config.port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, health: health(), latest: history().at(-1) ?? null });
      if (pathname === "/health") return json(health());
      if (pathname === "/history") return json(history());
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, health: health(), history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
  };
}
