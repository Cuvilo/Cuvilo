import { useEffect, useRef, useState } from "react";
import { Check, Clipboard } from "lucide-react";
import type { Copilot } from "@/hooks/use-copilot";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({ store, text, compact = false, label="复制答案", copiedLabel="已复制" }: { store: Pick<Copilot,"copy">; text: string; compact?: boolean;label?:string;copiedLabel?:string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const latest=useRef(text);latest.current=text;
  useEffect(()=>{setCopied(false);if(timer.current)clearTimeout(timer.current);},[text]);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  return <Button variant="ghost" disabled={!text} size={compact ? "icon-xs" : "sm"} aria-label={copied ? copiedLabel : label} title={copied ? copiedLabel : label}
    className={cn("text-muted-foreground", copied && "text-success")}
    onClick={async () => {
      if (await store.copy(text) && live.current && latest.current===text) {
        if (timer.current) clearTimeout(timer.current);
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }
    }}>
    {copied ? <Check /> : <Clipboard />}{!compact && <span>{copied ? "已复制" : "复制"}</span>}
  </Button>;
}
