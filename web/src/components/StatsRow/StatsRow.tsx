"use client";

import { useEffect, useState } from "react";
import type { BlockEvent, Health, Meta } from "@/lib/types";
import { fmtInt, uptime } from "@/lib/format";
import styles from "./StatsRow.module.css";

const DASH = "-";

export default function StatsRow({
  latest,
  avgLatencyMs,
  meta,
  health,
}: {
  latest: BlockEvent | null;
  avgLatencyMs: number;
  meta: Meta | null;
  health: Health | null;
}) {
  const startedAt = meta?.startedAt ?? null;
  // Ticks once a second; starts on the client so SSR and hydration agree.
  const [up, setUp] = useState<string | null>(null);

  useEffect(() => {
    if (startedAt == null) {
      setUp(null);
      return;
    }
    const tick = () => setUp(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const decision = latest?.decision ?? null;
  const last = decision && !decision.late ? `${decision.latencyMs} ms` : `${DASH} ms`;
  const avg =
    Number.isFinite(avgLatencyMs) && avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : DASH;
  const totals = latest?.totals ?? null;

  // Cost per hour is the number that decides whether this demo is affordable. Gas is charged on the
  // gas limit, so it is paid whether or not a quote lands: project the observed rate (blocks are
  // ~300 ms, so an hour is 12,000 of them) rather than the cumulative total, which only grows.
  const perBlock = totals && totals.blocks > 0 ? totals.gasMon / totals.blocks : 0;
  const gasMonPerHour = perBlock * 12_000;
  const usdPerMon = latest?.mid ?? 0;

  return (
    <div className={styles.stats}>
      <span>last {last}</span>
      <span>avg {avg}</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.decisions) : DASH} calls</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.fills) : DASH} fills</span>
      <span className={styles.nowrap}>
        gas {totals ? totals.gasMon.toFixed(2) : DASH} MON ({totals ? `$${totals.gasUsd.toFixed(3)}` : DASH}) |{" "}
        {gasMonPerHour.toFixed(0)} MON/hr ({usdPerMon ? `$${(gasMonPerHour * usdPerMon).toFixed(2)}` : DASH})
        {health && health.gasBudgetMon > 0 ? ` / budget ${health.gasBudgetMon}` : ""}
      </span>
      {health?.paused ? (
        <span className={styles.nowrap} style={{ color: "var(--late-ink)" }}>
          paused: {health.paused}
        </span>
      ) : null}
      {health && health.unknownOrphans > 0 ? (
        <span className={styles.nowrap} style={{ color: "var(--late-ink)" }}>
          {health.unknownOrphans} order(s) unaccounted
        </span>
      ) : null}
      <span className={styles.spacer} />
      <span>uptime {up ?? "00:00:00"}</span>
    </div>
  );
}
