import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Answer } from "@/types";

export function useAnswerFeed(answers: Answer[], sessionId: string) {
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Question expansion and menu pauses must survive layout-induced scroll events.
  const explicitlyPaused = useRef(false);
  const pausedQuestions = useRef(new Set<string>());
  const session = useRef(sessionId);
  const [paused, setPaused] = useState(false);

  const scrollToBottom = useCallback(() => {
    const element = viewport.current;
    if (element) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, []);
  const pause = (explicit = true) => {
    if (explicit) explicitlyPaused.current = true;
    if (following.current) pausedQuestions.current = new Set(answers.map((answer) => answer.questionId));
    following.current = false;
    setPaused(true);
  };
  const resume = () => {
    following.current = true;
    explicitlyPaused.current = false;
    setPaused(false);
    scrollToBottom();
  };
  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    if (element.scrollHeight - element.clientHeight - element.scrollTop > 48) pause(false);
    else if (!following.current && !explicitlyPaused.current) resume();
  };

  const preserveAnchor = (anchor: HTMLElement) => {
    pause();
    const top = anchor.getBoundingClientRect().top;
    return () => {
      const element = viewport.current;
      if (element && anchor.isConnected) element.scrollTop += anchor.getBoundingClientRect().top - top;
    };
  };

  useLayoutEffect(() => {
    if (session.current !== sessionId) {
      session.current = sessionId;
      following.current = true;
      explicitlyPaused.current = false;
      pausedQuestions.current.clear();
      setPaused(false);
    }
    if (following.current) scrollToBottom();
  }, [answers, sessionId, paused, scrollToBottom]);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToBottom();
    });
    observer.observe(element);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  const pending = paused ? answers.filter((answer) => !pausedQuestions.current.has(answer.questionId)).length : 0;
  return { viewport, content, paused, pending, pause, resume, onScroll, preserveAnchor };
}
