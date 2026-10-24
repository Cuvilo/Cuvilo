import type { Ref } from "react";
import { ArrowUp, ArrowUpRight, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { Copilot } from "@/hooks/use-copilot";
import { TooltipHint } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { IconButton } from "./common";

export function QuestionComposer({ store: s, compact = false, inputRef }: { store: Copilot; compact?: boolean; inputRef?: Ref<HTMLTextAreaElement> }) {
  const active = !!s.data.session;
  const generating = s.data.answers.some(answer => answer.status === "generating");
  const label = generating ? "停止生成" : "立即回答";
  return <div className={compact ? "question-composer question-composer-compact" : "question-composer"}>
    <div className="composer-panel">
      <Textarea ref={inputRef} className="min-h-16 max-h-32 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:bg-transparent focus-visible:ring-0" aria-label="手动输入问题" value={s.manual} rows={compact?1:2}
        onChange={event => s.setManual(event.target.value)} placeholder="输入或修正问题…"
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (active && !s.busy && !generating) void s.request();
          }
        }} />
      <div className="composer-actions">
        <div className="composer-tools">
          {!compact && <IconButton label="打开答案窗口" className="tool-button rounded-full bg-secondary hover:bg-surface-inset" onClick={() => void s.showAnswer()}><ArrowUpRight /></IconButton>}
        </div>
        <TooltipHint label={`${label} · ${generating ? s.data.settings.shortcuts.cancel : s.data.settings.shortcuts.answer}`}><Button variant={generating ? "secondary" : "primary"} size="icon-sm" className="composer-submit rounded-full"
          aria-label={label}
          disabled={!active || !!s.busy}
          onClick={() => generating ? void s.action("cancel", () => invoke("cancel_answer")) : void s.request()}>
          {generating ? <Square /> : <ArrowUp />}
        </Button></TooltipHint>
      </div>
    </div>
  </div>;
}
