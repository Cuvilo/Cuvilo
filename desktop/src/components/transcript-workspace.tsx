import {t as tr, useLocale} from "@/i18n";
import { ArrowDown } from "lucide-react";
import { visibleTranscripts } from "@/state";
import { useMemo } from "react";
import type { Transcript } from "@/types";
import { useTranscriptFeed } from "@/hooks/use-transcript-feed";
import { TranscriptRow } from "./answer-panel";
import { Button } from "./ui/button";
import { EmptyState } from "./common";

export function TranscriptWorkspace({ items, sessionId }: { items: Transcript[]; sessionId: string; active: boolean }) {
  useLocale();
  const visible = useMemo(() => visibleTranscripts(items), [items]);
  const feed = useTranscriptFeed(visible, sessionId);
  return <section className="transcript-workspace" aria-label={tr("转写工作区")}>
    <div ref={feed.viewport} className="transcript-viewport" role="log" aria-label={tr("实时转写")} aria-live="off" tabIndex={0} onScroll={feed.onScroll}>
      <div ref={feed.content} className="transcript-content">
        {feed.hasEarlier && <Button variant="ghost" size="sm" className="load-earlier" onClick={feed.loadEarlier}>{tr("加载更早的转写")}</Button>}
        {feed.items.length ? feed.items.map(item => <TranscriptRow key={item.id} item={item} />) :
          <EmptyState compact brand title={tr("实时转写")} />}
      </div>
    </div>
    {feed.paused && <div className="transcript-follow"><Button size="sm" onClick={feed.resume}>
      <ArrowDown />{feed.pending ? tr("{0} 条新转写 · 回到最新", feed.pending) : tr("回到最新")}
    </Button></div>}
  </section>;
}
