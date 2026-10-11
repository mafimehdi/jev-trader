"use client";

import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import StatsRow from "@/components/StatsRow/StatsRow";
import { useFeed, useStalled } from "@/lib/useFeed";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://jev-trader-production.up.railway.app";

export default function Page() {
  const feed = useFeed(API_URL);
  const stalled = useStalled(feed);

  return (
    <div className="card">
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} stalled={stalled} />
      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} health={feed.health} />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart events={feed.events} latest={feed.latest} />
          </div>
        </div>
        <div className={styles.right}>
          <DecisionPanel latest={feed.latest} paused={feed.health?.paused ?? null} />
          <Feed events={feed.events} />
        </div>
      </div>
    </div>
  );
}
