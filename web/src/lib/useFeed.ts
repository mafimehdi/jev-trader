"use client";

import { useEffect, useReducer, useState } from "react";
import type { BlockEvent, ConnectionState, FeedState, Fill, Health, Meta, Quote } from "./types";

export { useUptime } from "./useUptime";

/** Max block events kept in memory (oldest -> newest). */
const CAP = 1000;
/** Reconnect backoff, doubling from 1s up to 10s. */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
/** If nothing arrives for this long (server pings every few seconds), force a reconnect. */
const STALE_MS = 45_000;

interface State extends FeedState {
  /** running accumulators so avgLatencyMs stays O(1) per event */
  latSum: number;
  latCount: number;
  /** Guards reported by the server: paused reason, block age, orphaned orders. */
  health: Health | null;
}

type Action =
  | { type: "snapshot"; meta: Meta | null; health: Health | null; history: BlockEvent[] }
  | { type: "block"; event: BlockEvent }
  | { type: "fill"; block: number; fill: Fill }
  | { type: "quote"; block: number; quote: Quote }
  | { type: "connection"; connection: ConnectionState }
  | { type: "health"; health: Health | null };

const initialState: State = {
  meta: null,
  events: [],
  latest: null,
  connection: "connecting",
  avgLatencyMs: 0,
  latSum: 0,
  latCount: 0,
  health: null,
  lastBlockSeenAt: 0,
};

/** latencyMs of a decided (non-late) block, or null if it should not count. */
function latencyOf(e: BlockEvent): number | null {
  const d = e?.decision;
  if (!d || d.late || typeof d.latencyMs !== "number" || !Number.isFinite(d.latencyMs)) return null;
  return d.latencyMs;
}

function indexOfBlock(events: BlockEvent[], block: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].block === block) return i;
  return -1;
}

function avg(latSum: number, latCount: number): number {
  return latCount > 0 ? Math.round(latSum / latCount) : 0;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };

    case "health":
      return { ...state, health: action.health };

    case "snapshot": {
      const history = Array.isArray(action.history) ? action.history : [];
      const events = history.length > CAP ? history.slice(history.length - CAP) : history;
      let latSum = 0;
      let latCount = 0;
      for (const e of events) {
        const l = latencyOf(e);
        if (l !== null) {
          latSum += l;
          latCount++;
        }
      }
      return {
        meta: action.meta ?? state.meta,
        health: action.health ?? state.health,
        lastBlockSeenAt: Date.now(),
        events,
        latest: events.length ? events[events.length - 1] : null,
        connection: "live",
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
      };
    }

    case "block": {
      const ev = action.event;
      if (!ev || typeof ev.block !== "number") return state;
      const prev = state.events;
      const last = prev.length ? prev[prev.length - 1] : null;

      // Dedupe: a re-sent block replaces the one we already have; a stale older block is dropped.
      if (last && ev.block <= last.block) {
        const idx = indexOfBlock(prev, ev.block);
        if (idx < 0) return state;
        const events = prev.slice();
        const old = events[idx];
        events[idx] = ev;
        let latSum = state.latSum;
        let latCount = state.latCount;
        const o = latencyOf(old);
        if (o !== null) {
          latSum -= o;
          latCount--;
        }
        const n = latencyOf(ev);
        if (n !== null) {
          latSum += n;
          latCount++;
        }
        return {
          ...state,
          events,
          latest: events[events.length - 1],
          avgLatencyMs: avg(latSum, latCount),
          latSum,
          latCount,
        };
      }

      let latSum = state.latSum;
      let latCount = state.latCount;
      const n = latencyOf(ev);
      if (n !== null) {
        latSum += n;
        latCount++;
      }
      let events = prev.concat(ev);
      if (events.length > CAP) {
        const drop = events.length - CAP;
        for (let i = 0; i < drop; i++) {
          const l = latencyOf(events[i]);
          if (l !== null) {
            latSum -= l;
            latCount--;
          }
        }
        events = events.slice(drop); // only ever slices once we are over the cap
      }
      return {
        ...state,
        events,
        latest: ev,
        // The block itself carries the pause reason, so the dashboard does not wait a round trip.
        health: state.health ? { ...state.health, paused: ev.paused ?? null, lastBlock: ev.block, lastBlockTs: ev.ts, ageMs: 0, stale: false } : state.health,
        lastBlockSeenAt: Date.now(),
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
      };
    }

    case "fill": {
      const idx = indexOfBlock(state.events, action.block);
      if (idx < 0) return state;
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], fill: action.fill };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    case "quote": {
      const idx = indexOfBlock(state.events, action.block);
      if (idx < 0) return state;
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], quote: action.quote };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    default:
      return state;
  }
}

function parseHealth(raw: Record<string, unknown> | null): Health | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  return {
    paused: typeof h.paused === "string" ? h.paused : null,
    lastBlock: typeof h.lastBlock === "number" ? h.lastBlock : 0,
    lastBlockTs: typeof h.lastBlockTs === "number" ? h.lastBlockTs : 0,
    ageMs: typeof h.ageMs === "number" ? h.ageMs : -1,
    stale: Boolean(h.stale),
    consecutiveFailures: typeof h.consecutiveFailures === "number" ? h.consecutiveFailures : 0,
    consecutiveReverts: typeof h.consecutiveReverts === "number" ? h.consecutiveReverts : 0,
    inflight: typeof h.inflight === "number" ? h.inflight : 0,
    pendingStuck: Boolean(h.pendingStuck),
    unknownOrphans: typeof h.unknownOrphans === "number" ? h.unknownOrphans : 0,
    gasMon: typeof h.gasMon === "number" ? h.gasMon : 0,
    gasBudgetMon: typeof h.gasBudgetMon === "number" ? h.gasBudgetMon : 0,
  };
}

function parseMeta(raw: Record<string, unknown> | null): Meta | null {
  if (!raw) return null;
  return {
    model: typeof raw.model === "string" ? raw.model : "",
    wallet: typeof raw.wallet === "string" ? raw.wallet : null,
    dryRun: Boolean(raw.dryRun),
    market: typeof raw.market === "string" ? raw.market : "MON/USDC",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
  };
}

/**
 * Live block feed over SSE.
 *
 * Connects to `${apiUrl}/events` and handles: `snapshot` (meta + history),
 * `block` (append, deduped by block number, capped at 1000), `quote`
 * ({ block, quote } -> replaces that block's quote once its receipt lands), `fill`
 * ({ block, fill } -> a taker hit our resting order in that block) and `ping` (liveness).
 * Reconnects with 1s -> 10s backoff, surfacing `connection`.
 */
export function useFeed(apiUrl: string): FeedState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const base = (apiUrl || "").replace(/\/+$/, "");

    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };

    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStaleTimer();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          return;
        }
        fn(data);
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${base}/events`);

      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStaleTimer();
      };
      es.onerror = () => {
        if (!closed) scheduleReconnect();
      };

      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        const history = Array.isArray(d.history) ? (d.history as BlockEvent[]) : [];
        dispatch({ type: "snapshot", meta: parseMeta(d), health: parseHealth((d.health ?? null) as Record<string, unknown> | null), history });
      });
      handle("block", (data) => {
        dispatch({ type: "block", event: data as BlockEvent });
      });
      handle("fill", (data) => {
        const d = (data ?? {}) as { block?: number; fill?: Fill };
        if (typeof d.block !== "number" || !d.fill) return;
        dispatch({ type: "fill", block: d.block, fill: d.fill });
      });
      handle("quote", (data) => {
        const d = (data ?? {}) as { block?: number; quote?: Quote };
        if (typeof d.block !== "number" || !d.quote) return;
        dispatch({ type: "quote", block: d.block, quote: d.quote });
      });
      handle("ping", () => {
        // Keep-alive only. Liveness is decided by the age of the last *block*: a dead loop still pings.
        armStaleTimer();
      });
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [apiUrl]);

  return state;
}

/**
 * True when no block has arrived for STALE_MS, on the client clock: a dead loop keeps the SSE
 * connection open and keeps pinging, so only the age of the last block proves liveness.
 */
export function useStalled(state: FeedState): boolean {
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (state.health?.stale) return true;
  if (!now || !state.lastBlockSeenAt) return false;
  return now - state.lastBlockSeenAt > STALE_MS;
}

export default useFeed;
