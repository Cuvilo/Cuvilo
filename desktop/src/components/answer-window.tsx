import {t as tr, useLocale, messageText} from "@/i18n";
import {AnswerSources} from "./answer-sources";
import { manualShortcut,shortcutMatches } from "@/lib/shortcut-validation";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowDown, BookOpen, PencilLine, MoreHorizontal, Pin, RefreshCw, Square, X, Zap } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import type { Copilot } from "@/hooks/use-copilot";
import type { Answer } from "@/types";
import { useAnswerFeed } from "@/hooks/use-answer-feed";
import { questionTimeline } from "@/state";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {AnswerWordsInput} from "./answer-words-input";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { AnswerText } from "./answer-panel";
import { EmptyState, IconButton, Notice, Spinner, Toast } from "./common";
import { CopyButton } from "./copy-button";
import { TooltipHint } from "./ui/tooltip";
import { BrandMark } from "./brand-mark";
import { QuestionComposer } from "./question-composer";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { ScreenQuestionActions, ScreenQuestionStatus } from "./screen-question";
import { ScanText } from "lucide-react";
import { CollapsibleQuestion } from "./collapsible-question";

function AnswerThreadItem({ answer, store: s, enter, preserveAnchor }: { answer: Answer; store: Copilot; enter: boolean; preserveAnchor: (element: HTMLElement) => () => void }) {
  useLocale();
  // Entry belongs to the question, never to a streamed text update or revision.
  const [entering, setEntering] = useState(enter);
  return <article className={cn("answer-thread-card", entering && "answer-entry")}
    onAnimationEnd={() => setEntering(false)} data-question-id={answer.questionId}>
    <ScreenQuestionActions answer={answer} store={s}/>
    <CollapsibleQuestion text={answer.question} preserveAnchor={preserveAnchor} />
    <AnswerText answer={answer} fontSize={s.fontSize} onCopy={text=>s.copy(text,true)} />
    <AnswerSources answer={answer} actions={<>
      {answer.status === "generating" && <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner />{tr("生成中")}</span>}
      {answer.status === "error" && <span className="text-xs text-destructive">{tr("生成失败")}</span>}
      {answer.status === "cancelled" && <span className="text-xs text-muted-foreground">{tr("已停止")}</span>}
      <CopyButton store={s} text={answer.text} compact />
      <DropdownMenu>
        <TooltipHint label={tr("答案操作")}><DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={tr("答案操作")} className="text-muted-foreground"><MoreHorizontal /></Button>
        </DropdownMenuTrigger></TooltipHint>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={!s.data.session || !!s.busy} onSelect={() => void s.request("detail", answer)}><BookOpen />{tr("展开解释")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!s.data.session || !!s.busy} onSelect={() => void s.request("short", answer)}><RefreshCw />{tr("重新生成")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>}/>
  </article>;
}

export function AnswerWindow({ store: s }: { store: Copilot }) {
  useLocale();
  const answers = useMemo(() => questionTimeline(s.data.answers), [s.data.answers]);
  const sessionId = s.data.session?.id ?? answers.at(-1)?.sessionId ?? "";
  const feed = useAnswerFeed(answers, sessionId);
  const reduce = useReducedMotion();
  const previous = useRef({ sessionId, ids: new Set<string>(), hydrated: false });
  const entriesReady = previous.current.hydrated && previous.current.sessionId === sessionId;
  useLayoutEffect(() => {
    previous.current = { sessionId, ids: new Set(answers.map((answer) => answer.questionId)), hydrated: answers.length > 0 };
  }, [answers, sessionId]);
  const screen=s.data.screenCapture;
  const recognizing=screen?.stage==="capturing"||screen?.stage==="recognizing";
  const pendingScreen=recognizing||screen?.stage==="ready";
  const generating = answers.some((answer) => answer.status === "generating");
  const meetingError = s.notices.some((notice) => notice.source === "meeting" && notice.error);
  const connected = !!s.data.session && /已连接|转写中/.test(s.currentStatus);
  const [pinBusy, setPinBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const [manualFocusVersion,setManualFocusVersion]=useState(0);
  const manualInput=useRef<HTMLTextAreaElement>(null);
  const manualTimer=useRef<number|null>(null);
  const focusPending=useRef(false);
  const [manualNode, setManualNode] = useState<HTMLDivElement | null>(null);
  const [manualHeight, setManualHeight] = useState(48);
  const opacityInput = useRef<HTMLInputElement>(null);
  const wordsInput = useRef<HTMLInputElement>(null);
  const manualTrigger = useRef<HTMLButtonElement>(null);
  const manualFromMenu = useRef(false);
  const manualOutside = useRef(false);
  const eligibility=useRef({sessionId:s.data.session?.id,pending:pendingScreen});
  eligibility.current={sessionId:s.data.session?.id,pending:pendingScreen};
  const focusManual=()=>{if(!manualOutside.current&&manualInput.current){manualInput.current.focus({preventScroll:true});if(document.hasFocus())focusPending.current=false;}};
  const openManual=()=>{if(!eligibility.current.sessionId||eligibility.current.pending)return;manualOutside.current=false;focusPending.current=true;setManualOpen(true);setManualFocusVersion(value=>value+1);};
  const queueManual=()=>{
    if(manualTimer.current!==null)window.clearTimeout(manualTimer.current);
    const requestedSession=eligibility.current.sessionId;
    manualTimer.current=window.setTimeout(()=>{manualTimer.current=null;if(eligibility.current.sessionId===requestedSession)openManual();},0);
  };
  const requestManual=()=>{if(menuOpen||manualFromMenu.current){manualFromMenu.current=true;setMenuOpen(false);}else if(manualTimer.current===null)openManual();};
  useEffect(()=>{
    setManualOpen(false);manualFromMenu.current=false;focusPending.current=false;
    if(manualTimer.current!==null){window.clearTimeout(manualTimer.current);manualTimer.current=null;}
  },[s.data.session?.id,pendingScreen]);
  useEffect(()=>()=>{if(manualTimer.current!==null)window.clearTimeout(manualTimer.current);},[]);
  useEffect(()=>{
    if(!manualOpen)return;
    const frame=requestAnimationFrame(()=>{if(focusPending.current)focusManual();});
    const restored=()=>{if(focusPending.current)focusManual();};
    window.addEventListener("focus",restored);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener("focus",restored);};
  },[manualOpen,manualFocusVersion]);
  useEffect(()=>{if(s.manualRequest&&s.manualRequest.sessionId===s.data.session?.id)requestManual();},[s.manualRequest]);
  useEffect(()=>{
    if(s.native)return;
    const keydown=(event:KeyboardEvent)=>{if(eligibility.current.sessionId&&!eligibility.current.pending&&shortcutMatches(event,manualShortcut(s.data.settings.shortcuts))){event.preventDefault();requestManual();}};
    window.addEventListener("keydown",keydown);return()=>window.removeEventListener("keydown",keydown);
  },[s.native,s.data.settings.shortcuts,menuOpen]);
  useLayoutEffect(() => {
    if (!manualNode) return;
    const measure = () => setManualHeight(Math.ceil(manualNode.getBoundingClientRect().height) || 48);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(manualNode);
    return () => observer.disconnect();
  }, [manualNode]);
  const toggleTop = async () => {
    const next = !s.top;
    setPinBusy(true);
    try {
      if (s.native) await getCurrentWindow().setAlwaysOnTop(next);
      s.setTop(next);
    } catch (error) { s.notify(String(error), "error"); }
    finally { setPinBusy(false); }
  };
  return <div className={cn("answer-window", manualOpen && "answer-window-manual-open")} style={{ "--answer-background-opacity":s.answerOpacity/100, "--answer-manual-height": `${manualHeight}px` } as CSSProperties}>
    <header className="answer-window-header" data-tauri-drag-region>
      <BrandMark className="size-5" data-tauri-drag-region />
      <TooltipHint label={s.currentStatus}><span role="status" aria-label={s.currentStatus}
        className={cn("status-dot", connected && "bg-success", meetingError && "bg-destructive")} /></TooltipHint>
      <span className="h-full min-w-3 flex-1" data-tauri-drag-region />
      <TooltipHint label={(recognizing||generating ? s.data.settings.shortcuts.cancel : s.data.settings.shortcuts.answer)||tr("可在设置中启用快捷键")}><Button variant={recognizing||generating ? "secondary" : "primary"} size="sm" className="answer-primary-action h-7 w-[88px] gap-1 rounded-lg px-2 text-xs leading-[18px] has-[>svg]:px-2" disabled={!s.data.session || !!s.busy || screen?.stage==="ready"}
        onClick={() => recognizing ? void s.action("screen-cancel",()=>invoke("cancel_screen_capture")) : generating ? void s.action("cancel", () => invoke("cancel_answer")) : void s.request()}>
        {recognizing||generating ? <Square /> : <Zap />}{recognizing ? tr("取消识别") : generating ? tr("停止生成") : tr("立即回答")}
      </Button></TooltipHint>
      <IconButton label={s.top ? tr("取消置顶") : tr("置顶窗口")} size="icon-xs" aria-pressed={s.top}
        className="tool-button pin-toggle rounded-full" disabled={pinBusy} onClick={() => void toggleTop()}><Pin /></IconButton>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <TooltipHint label={tr("更多")}><DropdownMenuTrigger asChild>
          <Button ref={manualTrigger} variant="ghost" size="icon-xs" className="tool-button rounded-full bg-secondary hover:bg-surface-inset text-muted-foreground" aria-label={tr("更多")}><MoreHorizontal /></Button>
        </DropdownMenuTrigger></TooltipHint>
        <DropdownMenuContent className="answer-reading-menu" onCloseAutoFocus={event => { if (manualFromMenu.current) { event.preventDefault(); manualFromMenu.current = false; queueManual(); } }}>
          <DropdownMenuItem disabled={!s.data.session||pendingScreen||screen?.stage==="answering"||!!s.busy} onSelect={()=>void s.action("screen",async()=>{if(!await s.preferences.retry())throw "设置未保存，请重试";await invoke("begin_screen_capture");})}><ScanText/>{tr("截图提问")}<span className="ml-auto text-xs text-muted-foreground">{s.data.settings.shortcuts.screen||""}</span></DropdownMenuItem>
          <DropdownMenuItem aria-label={tr("手动提问")} disabled={!s.data.session||pendingScreen} onSelect={() => { manualFromMenu.current = true; }}><PencilLine />{tr("手动提问")}<span className="ml-auto text-xs text-muted-foreground">{manualShortcut(s.data.settings.shortcuts)}</span></DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="answer-font-row" role="group" aria-label={tr("答案字号")}>
            <span>{tr("字号")}</span><div><Button variant="ghost" size="icon-xs" aria-label={tr("减小字号")} disabled={s.fontSize <= 14} onClick={() => s.setFontSize(size => Math.max(14,size-1))}>A−</Button><span className="tabular-nums">{s.fontSize}</span><Button variant="ghost" size="icon-xs" aria-label={tr("增大字号")} disabled={s.fontSize >= 30} onClick={() => s.setFontSize(size => Math.min(30,size+1))}>A＋</Button></div>
          </div>
          <div className="answer-words-menu"><DropdownMenuItem aria-label={tr("调整生成字数")} onSelect={event=>{event.preventDefault();wordsInput.current?.focus();}}>{tr("生成字数")}</DropdownMenuItem><AnswerWordsInput ref={wordsInput} store={s} id="reading-answer-words"/></div>
          <div className="answer-opacity-menu">
            <DropdownMenuItem className="answer-opacity-heading" aria-label={tr("调整背景透明度")} onSelect={event=>{event.preventDefault();opacityInput.current?.focus();}}>{tr("背景透明度")}<output htmlFor="reading-opacity">{100-s.answerOpacity}%</output></DropdownMenuItem>
            <input ref={opacityInput} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))event.stopPropagation();}} id="reading-opacity" aria-label={tr("背景透明度")} type="range" min={0} max={80} step={1} value={100-s.answerOpacity} onChange={event=>s.updatePreferences({answerOpacity:100-Number(event.target.value)})}/>
            {s.preferences.status==="error"&&<div className="answer-opacity-error" role="alert"><span>{messageText(s.preferences.error)}</span><Button size="xs" variant="ghost" onClick={()=>void s.preferences.retry()}>{tr("重试")}</Button></div>}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={feed.paused} onCheckedChange={(paused) => paused ? feed.pause() : feed.resume()}>
            {tr("暂停自动跟随")}</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipHint label={tr("结束")}><Button variant="destructive" aria-label={tr("结束")} size="icon-xs" className="answer-end rounded-full" disabled={!!s.busy}
        onClick={() => void s.end()}>{s.busy === "stop" ? <Spinner /> : <X />}</Button></TooltipHint>
    </header>
    {s.notices.some((notice) => notice.error) && <div className="answer-window-notices">
      {s.notices.filter((notice) => notice.error).map((notice) => <Notice key={notice.source} error>{notice.message}</Notice>)}
    </div>}
    <div className="answer-reading-area">
    <main ref={feed.viewport} className="answer-window-body" role="log" aria-label={tr("问题与答案")} aria-live="off" tabIndex={0} onScroll={feed.onScroll}>
      <div ref={feed.content} className={cn("answer-thread", feed.paused && "answer-thread-paused")}>
        {answers.length ? answers.map((answer) => <AnswerThreadItem key={`${sessionId}:${answer.questionId}`} answer={answer} store={s} preserveAnchor={feed.preserveAnchor}
          enter={!reduce && !feed.paused && entriesReady && !previous.current.ids.has(answer.questionId)} />) :
          !pendingScreen&&screen?.stage!=="error"&&<div className="answer-thread-card"><EmptyState compact brand title={tr("等待提问")} /></div>}
        <ScreenQuestionStatus store={s}/>
      </div>
    </main>
      {feed.paused && <Button variant="secondary" size="sm" className="answer-resume h-7 rounded-full px-2.5 text-xs has-[>svg]:px-2.5" onClick={feed.resume}>
        <ArrowDown className="size-3.5 shrink-0" /><span className="truncate">{feed.pending ? tr("{0} 条新问题", feed.pending) : tr("回到最新")}</span>
      </Button>}
    </div>
    <Dialog modal={false} open={manualOpen} onOpenChange={setManualOpen}>
      <DialogContent ref={setManualNode} className="answer-manual-input" showOverlay={false} showCloseButton={false}
        onOpenAutoFocus={event => { event.preventDefault(); manualOutside.current = false; focusPending.current=true; focusManual(); }}
        onPointerDownOutside={() => { manualOutside.current = true; }}
        onFocusOutside={event => event.preventDefault()}
        onEscapeKeyDown={() => { manualOutside.current = false; }}
        onCloseAutoFocus={event => { event.preventDefault(); if (!manualOutside.current) manualTrigger.current?.focus(); }}>
        <DialogTitle className="sr-only">{tr("手动输入问题")}</DialogTitle>
        <DialogDescription className="sr-only">{tr("Enter 提交，Shift + Enter 换行。点击外部或按 Esc 收起，保留草稿。")}</DialogDescription>
        <QuestionComposer store={s} compact inputRef={manualInput} />
      </DialogContent>
    </Dialog>
    <Toast notification={s.toast} onDismiss={s.dismissToast} />
  </div>;
}
