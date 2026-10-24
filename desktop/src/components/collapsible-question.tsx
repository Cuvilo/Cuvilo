import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "./ui/button";

export function CollapsibleQuestion({ text, preserveAnchor }: {
  text: string;
  preserveAnchor: (element: HTMLElement) => () => void;
}) {
  const id = useId();
  const bubble = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLHeadingElement>(null);
  const restore = useRef<(() => void) | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandable, setExpandable] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 22;
      setExpandable(element.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  useLayoutEffect(() => {
    restore.current?.();
    restore.current = null;
  }, [expanded]);
  return <div ref={bubble} className="answer-question compact-answer-question" data-expandable={expandable}>
    <h2 id={id} ref={content} className="compact-question-text" data-expanded={expanded}>{text}</h2>
    {expandable && <Button variant="ghost" size="icon-xs" className="question-toggle"
      aria-label={expanded ? "收起完整问题" : "展开完整问题"} aria-expanded={expanded} aria-controls={id}
      onClick={() => {
        if (bubble.current) restore.current = preserveAnchor(bubble.current);
        setExpanded(value => !value);
      }}>{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</Button>}
  </div>;
}
