const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string) => (env(key) ? Number(env(key)) : undefined);

export const config = {
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!, // sends, receipts, nonce, gas estimation
  readRpcUrl: env("READ_RPC_URL", "https://rpc.monad.xyz")!, // book reads + eth_blockNumber polling + trade logs
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  /** Kuru MarginAccount this market settles against (slot 73 of the OrderBook proxy; verifiedMarket(market) is true). */
  marginAccount: env("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5")!,
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  tradeSizeMon: Number(env("TRADE_SIZE_MON", "200")), // Kuru MON-USDC minimum order is 200 MON
  maxPositionMon: Number(env("MAX_POSITION_MON", "1000")),
  bankrollUsd: Number(env("BANKROLL_USD", "100")), // used for pnlPct
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Startup deposits into the Kuru margin account, topped up to these balances. Limit orders draw from margin, not the wallet. */
  marginMon: Number(env("MARGIN_MON", "600")),
  marginUsdc: Number(env("MARGIN_USDC", "20")),
  // Monad charges gas on the LIMIT, so never estimate per block: estimate once at init (or override) and hardcode.
  gasLimit: num("GAS_LIMIT"),
  gasLimitFallback: 350_000, // batchUpdate: one cancel + one post-only place measured at ~282k for the place alone
  // EIP-1559 type-2 only. Effective price = base + priority, so a high static cap is free.
  maxFeeGwei: Number(env("MAX_FEE_GWEI", "400")),
  priorityFeeGwei: Number(env("PRIORITY_FEE_GWEI", "2")), // Monad hardcodes eth_maxPriorityFeePerGas at 2
  pendingBlocks: 10, // first report a missing receipt after this many blocks; keep checking until resolved
  refreshBlocks: 200, // how often to refresh the fee estimate, margin balances and the vault check
  // Guards. Nothing in the block loop may hang or burn gas unattended: every one of these ends in `paused`.
  modelTimeoutMs: Number(env("MODEL_TIMEOUT_MS", "250")), // a model call past this rejects; the block goes out late
  modelFailureLimit: Number(env("MODEL_FAILURE_LIMIT", "5")), // consecutive failures that stop quoting (decisions keep retrying)
  revertLimit: Number(env("REVERT_LIMIT", "3")), // consecutive reverted/lost quotes that stop quoting
  probeBlocks: Number(env("PROBE_BLOCKS", "400")), // while paused by reverts, one probe tx every this many blocks
  /** Live only: stop quoting once cumulative gas passes this many MON. 0 = off. A 30 minute session is ~215 MON. */
  gasBudgetMon: Number(env("GAS_BUDGET_MON", "0")),
  /** Stop sending while an unconfirmed tx is older than this many blocks (a stuck nonce). */
  pendingStuckBlocks: Number(env("PENDING_STUCK_BLOCKS", "10")), // stop sends while any receipt remains unresolved
  /** No block for this long marks the snapshot stale, so a wedged loop cannot look live. */
  staleMs: Number(env("STALE_MS", "5000")),
  /** Rotate data/events.jsonl once past this size (bytes). It grows ~4 KB per block. 0 = never. */
  eventLogMaxBytes: Number(env("EVENT_LOG_MAX_BYTES", String(64 * 1024 * 1024))),
  /** Optional bearer secret for downloading event logs. Unset disables the export route. */
  eventExportToken: env("EVENT_EXPORT_TOKEN"),
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  model: env("MODEL", "mock") as "mock" | "jev",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
};
