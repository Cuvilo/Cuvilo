import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Transcript } from "@/types";

const pageSize = 80;
type Anchor = { id: string; offset: number; height: number; top: number };

// Presentation state only; ASR fragments continue to be merged by their existing IDs.
export function useTranscriptFeed(items: Transcript[], sessionId: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const session = useRef(sessionId);
  const following = useRef(true);
  const pausedIds = useRef(new Set<string>());
  const anchor = useRef<Anchor | null>(null);
  const [start, setStart] = useState(Math.max(0, items.length - pageSize));
  const [capacity, setCapacity] = useState(pageSize);
  const [paused, setPaused] = useState(false);
  const bottom = () => {
    const element = viewport.current;
    if (element) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  };
  const pause = () => {
    if (following.current) pausedIds.current = new Set(items.map(item => item.id));
    following.current = false;
    setPaused(true);
  };
  const resume = () => {
    following.current = true;
    anchor.current = null;
    setPaused(false);
    setStart(Math.max(0, items.length - capacity));
    bottom();
  };
  const onScroll = () => {
    const element = viewport.current;
    if (!element || anchor.current) return;
    if (element.scrollHeight - element.clientHeight - element.scrollTop > 48) pause();
    else if (!following.current) resume();
  };
  const loadEarlier = () => {
    const element = viewport.current;
    if (!element || start === 0) return;
    const top = element.getBoundingClientRect().top;
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-transcript-id]"))
      .find(item => item.getBoundingClientRect().bottom > top);
    anchor.current = {
      id: row?.dataset.transcriptId ?? "",
      offset: row ? row.getBoundingClientRect().top - top : 0,
      height: element.scrollHeight,
      top: element.scrollTop,
    };
    pause();
    setCapacity(value => value + pageSize);
    setStart(value => Math.max(0, value - pageSize));
  };
  useLayoutEffect(() => {
    if (session.current !== sessionId) {
      session.current = sessionId;
      following.current = true;
      pausedIds.current.clear();
      anchor.current = null;
      setPaused(false);
      setCapacity(pageSize);
      setStart(Math.max(0, items.length - pageSize));
      bottom();
      return;
    }
    const element = viewport.current;
    if (element && anchor.current) {
      const saved = anchor.current;
      const row = Array.from(element.querySelectorAll<HTMLElement>("[data-transcript-id]"))
        .find(item => item.dataset.transcriptId === saved.id);
      if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
      else element.scrollTop = saved.top + element.scrollHeight - saved.height;
      anchor.current = null;
    } else if (following.current) {
      setStart(Math.max(0, items.length - capacity));
      bottom();
    }
  }, [items, sessionId, start, capacity, paused]);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) bottom(); });
    observer.observe(element);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const pending = paused ? items.filter(item => !pausedIds.current.has(item.id)).length : 0;
  return { viewport, content, items: items.slice(start), hasEarlier: start > 0, paused, pending, loadEarlier, resume, onScroll };
}
