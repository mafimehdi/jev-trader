export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
/** This block's post-only limit order. `sent` until its receipt lands, then `placed` or `reverted`. */
export interface Quote { side: Side; price: number; size: number; txHash: string | null; gasMon: number; cancel: number[]; status: "sent" | "placed" | "reverted" | "lost" | "sim"; orderId: number | null; capped: boolean }
/** A taker hit one of our resting orders. */
export interface Fill { side: Side; size: number; price: number; txHash: string | null; orderId: number; simulated: boolean }
export interface Decision { action: Action; probabilities: { buy: number; sell: number; hold: number }; upIn10: number; latencyMs: number; late: boolean }
export interface Position { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number }
export interface Totals { blocks: number; decisions: number; quotes: number; fills: number; reverted: number; lateBlocks: number; jevUsd: number; gasMon: number; gasUsd: number; realizedUsd: number; pnlUsd: number; pnlMon: number; pnlPct: number }
export interface BlockEvent { block: number; ts: number; mid: number; bestBid: number; bestAsk: number; spreadBps: number; decision: Decision | null; quote: Quote | null; fill: Fill | null; resting: { bidMon: number; askMon: number }; position: Position; totals: Totals; /** Why quoting is stopped, or null while quoting. */ paused?: string | null }
export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }
/** Guards reported by the server (GET / and the stream snapshot). `stale` means no block for a while. */
export interface Health {
  paused: string | null;
  lastBlock: number;
  lastBlockTs: number;
  ageMs: number;
  stale: boolean;
  consecutiveFailures: number;
  consecutiveReverts: number;
  inflight: number;
  pendingStuck: boolean;
  unknownOrphans: number;
  gasMon: number;
  gasBudgetMon: number;
}
export type ConnectionState = "connecting" | "live" | "reconnecting";
export interface FeedState { meta: Meta | null; events: BlockEvent[]; latest: BlockEvent | null; connection: ConnectionState; avgLatencyMs: number; health: Health | null; lastBlockSeenAt: number }
