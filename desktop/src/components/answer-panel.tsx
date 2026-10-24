import {t as tr, currentLocale, useLocale} from "@/i18n";
import {CodeBlock} from "./code-block";
import {AnswerSources} from "./answer-sources";
import { transcriptDisplayText, visibleTranscripts } from "@/state";
import { CopyButton } from "./copy-button";
import { memo,createContext,useContext,type ComponentPropsWithoutRef } from "react";
import ReactMarkdown,{type ExtraProps,type Components} from "react-markdown";
import {
  AudioLines,
  BookOpen,
  Clock3,
  RefreshCw,
  Square,
  Zap,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { Copilot } from "@/hooks/use-copilot";
import type { Answer, Transcript } from "@/types";
import { milliseconds, transcriptLabel } from "@/state";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { EmptyState, Spinner } from "./common";

const CodeCopyContext=createContext<{onCopy?:(text:string)=>Promise<boolean>;enabled:boolean}>({enabled:true});
function MarkdownPre({node,children}:ComponentPropsWithoutRef<"pre">&ExtraProps){
  useLocale();
 const {onCopy,enabled}=useContext(CodeCopyContext);
 if(!enabled)return <pre>{children}</pre>;
 const code=node?.children.find(child=>child.type==="element"&&child.tagName==="code");
 const text=code&&code.type==="element"?code.children.map(child=>child.type==="text"?child.value:"").join(""):"";
 const classes=code&&code.type==="element"?code.properties.className:[];
 const language=Array.isArray(classes)?classes.find(value=>typeof value==="string"&&value.startsWith("language-"))?.toString().slice(9):undefined;
 return <CodeBlock text={text} language={language} onCopy={onCopy}>{children}</CodeBlock>;
}
const markdownComponents:Components={a:({children})=><span>{children}</span>,pre:MarkdownPre};
export const AnswerText=memo(function AnswerText({answer,fontSize,onCopy,codeCopy=true}:{answer:Answer;fontSize:number;onCopy?:(text:string)=>Promise<boolean>;codeCopy?:boolean}){
  useLocale();
 return <div className="answer-markdown flex-1" style={{fontSize}}><CodeCopyContext.Provider value={{onCopy,enabled:codeCopy}}><ReactMarkdown components={markdownComponents}>{answer.text||tr("正在整理回答…")}</ReactMarkdown></CodeCopyContext.Provider>{answer.status==="generating"&&<span className="stream-caret"/>}</div>;
});

const statusText: Record<string, string> = {
  generating: "正在生成",
  complete: "已完成",
  cancelled: "已停止",
  error: "生成失败",
};
export function AnswerCard({
  answer,
  store: s,
  embedded = false,
  readOnly = false,
}: {
  answer?: Answer;
  store: Copilot;
  embedded?: boolean;
  readOnly?: boolean;
}) {
  useLocale();
  return (
    <article
      className={cn(
        "min-w-0 bg-card",
        embedded ? "px-5 py-4" : "answer-card",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Zap className="size-3.5" />
          {answer?.mode.startsWith("screen") ? tr("屏幕提问") : answer?.mode === "detail" ? tr("详细解释") : tr("短答")}
        </span>
        {answer && (
          <Badge
            variant="secondary"
            className={cn(
              "gap-1.5 font-normal",
              answer.status === "generating" && "bg-primary/8 text-primary",
              answer.status === "error" && "bg-destructive/8 text-destructive",
            )}
          >
            {answer.status === "generating" && <Spinner />}
            {tr(statusText[answer.status] ?? answer.status)}
          </Badge>
        )}
      </div>
      {answer ? (
        <>
          <h2 className="answer-question mb-4 mt-4 text-[15px] font-medium leading-6 [overflow-wrap:anywhere]">
            {answer.question}
          </h2>
          <AnswerText answer={answer} fontSize={s.fontSize} onCopy={text=>s.copy(text,true)} /><AnswerSources answer={answer}/>
          {readOnly && <details className="mt-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{tr("响应耗时")}</summary>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3" />
              {tr("首句")}{milliseconds(answer.firstSentenceMs)}
            </span>
            <span>{tr("模型首字")}{" "}{milliseconds(answer.firstTokenMs)}</span>
            {answer.revision > 1 && <span>{tr("修订")}{" "}{answer.revision}</span>}
            </div>
          </details>}
          <div className="mt-4 flex flex-wrap items-center gap-1.5 pt-3">
            <CopyButton store={s} text={answer.text} />
            {!readOnly && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={!s.data.session || s.busy === "answer"}
                  onClick={() => void s.request("detail", answer)}
                >
                  <BookOpen />
                  {tr("展开")}</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={!s.data.session || s.busy === "answer"}
                  onClick={() => void s.request("short", answer)}
                >
                  <RefreshCw />
                  {tr("重答")}</Button>
                {answer.status === "generating" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() =>
                      void s.action("cancel", () => invoke("cancel_answer"))
                    }
                  >
                    <Square />
                    {tr("停止")}</Button>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <EmptyState
          compact
          brand
          title={tr("等待提问")}
        />
      )}
    </article>
  );
}
export function TranscriptRow({ item: t }: { item: Transcript }) {
  useLocale();
  const text = transcriptDisplayText(t.text);
  if (!text) return null;
  return <div className={cn("transcript-row", !t.isFinal && "transcript-interim")} data-transcript-id={t.id}>
    <div className="transcript-meta"><span>{transcriptLabel(t)}</span>
      <time dateTime={new Date(t.at).toISOString()}>{new Date(t.at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      {!t.isFinal && <span>{tr("识别中…")}</span>}
    </div><p>{text}</p>
  </div>;
}

export function TranscriptList({ items, compact = false }: { items: Transcript[]; compact?: boolean }) {
  useLocale();
  const visible = visibleTranscripts(items);
  if (!visible.length) return <EmptyState compact title={tr("等待会议声音")} icon={AudioLines} />;
  return <div className={cn("transcript-list", compact && "transcript-list-compact")}>
    {(compact ? visible.slice(-80) : visible).map(item => <TranscriptRow key={item.id} item={item} />)}
  </div>;
}
