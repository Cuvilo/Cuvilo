import {t as tr, currentLocale, useLocale, messageText} from "@/i18n";
import {AnswerSources} from "./answer-sources";
import type { ReactNode } from "react";
import { TooltipHint } from "./ui/tooltip";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, List, MoreHorizontal, Trash2 } from "lucide-react";
import type { Copilot } from "@/hooks/use-copilot";
import type { Answer, Session, ReviewReadingState } from "@/types";
import { questionTimeline, visibleTranscripts } from "@/state";
import { AnswerText, TranscriptList } from "./answer-panel";
import { CopyButton } from "./copy-button";
import { EmptyState, Notice, Spinner } from "./common";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

function ReviewAnswer({ answer, store: s, index, expanded, toggle }: { answer: Answer; store: Copilot; index:number; expanded: boolean; toggle: () => void }) {
  useLocale();
  const id = useId();
  const saved = answer.status === "generating" ? { ...answer, status: "cancelled" } : answer;
  const status = answer.status === "generating" ? "参考答案 · 未完成" : answer.status === "cancelled" ? "参考答案 · 已停止" : answer.status === "error" ? "参考答案 · 生成失败" : "参考答案";
  return <article className="review-document-question" data-question-id={answer.questionId}>
    {answer.mode.startsWith("screen")&&<p className="screen-review-source">{tr("屏幕提问")}</p>}
    <div className="review-question-top"><h2><button className="review-question-heading" aria-expanded={expanded} aria-controls={id} onClick={toggle}>
      <span className="review-question-number" aria-hidden="true">{String(index+1).padStart(2,"0")}</span><span className="review-question-title">{answer.question}</span>{expanded ? <ChevronDown /> : <ChevronRight />}
    </button></h2>{answer.text&&<TooltipHint label={tr("复制答案")}><span className="review-copy"><CopyButton store={s} text={answer.text} compact/></span></TooltipHint>}</div>
    {expanded ? <div id={id} className="review-question-body">
      {answer.text ? <AnswerText answer={saved} fontSize={Math.max(15,s.fontSize)} onCopy={text=>s.copy(text,true)} /> : <p className="text-sm text-muted-foreground">{tr("未生成参考答案")}</p>}
      <AnswerSources answer={answer}/>{answer.status!=="complete"&&<p className="review-answer-state">{tr(status)}</p>}
    </div> : <div id={id} className="review-question-excerpt" aria-hidden="true">{answer.text ? <AnswerText answer={saved} fontSize={15} codeCopy={false} /> : <p>{tr("未生成参考答案")}</p>}</div>}
  </article>;
}

function ReviewSessionInfo({ session, id }: { session: Session; id: string }) {
  useLocale();
  const minutes = Math.max(0, Math.floor(((session.endedAt ?? session.createdAt) - session.createdAt) / 60000));
  const started = new Date(session.createdAt);
  return <dl id={id} className="review-session-info" aria-label={tr("面试信息")}>
    <div><dt className="sr-only">{tr("开始时间")}</dt><dd><time dateTime={started.toISOString()}>{started.toLocaleString(currentLocale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></dd></div>
    {session.endedAt != null && <div><dt className="sr-only">{tr("时长")}</dt><dd>{minutes < 1 ? tr("不足 1 分钟") : tr("{0} 分钟", minutes)}</dd></div>}
  </dl>;
}

export function ReviewDocument({ store: s, review=s.review, memory, onDelete, deleteDisabled=false, quietTitle, leading }: { store: Copilot;review?:Pick<Copilot["review"],"session"|"answers"|"transcripts">;memory?:Record<string,ReviewReadingState>;onDelete?:()=>void;deleteDisabled?:boolean;quietTitle?:string;leading?:ReactNode }) {
  useLocale();
  const sessionId=review.session!.id;
  const remembered=memory?.[sessionId];
  const infoId = useId();
  const answers = useMemo(() => questionTimeline(review.answers), [review.answers]);
  const transcripts = visibleTranscripts(review.transcripts);
  const [tab, setTab] = useState(remembered?.tab??"answers");
  const [expanded, setExpanded] = useState(() => new Set(remembered?.expanded??answers.slice(0, 1).map(answer => answer.questionId)));
  const allExpanded=answers.length>0&&answers.every(answer=>expanded.has(answer.questionId));
  const [current, setCurrent] = useState(remembered?.current??answers[0]?.questionId ?? "");
  const [directory, setDirectory] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef<Record<string, number>>({...remembered?.positions, answers:remembered?.positions.answers??0,transcripts:remembered?.positions.transcripts??0});
  const jump = useRef<string | null>(null);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const remember=()=>{if(memory)memory[sessionId]={tab,expanded:[...expanded],current,positions:{...positions.current}};};
  useEffect(remember,[tab,expanded,current,memory,sessionId]);
  const changeTab = (value: string) => {
    if (scroll.current) positions.current[tab] = scroll.current.scrollTop;
    setTab(value);
  };
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = positions.current[tab] ?? 0; }, [tab]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const target = jump.current && [...(viewport?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [])].find(item => item.dataset.questionId === jump.current);
    if (viewport && target) {
      viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
      positions.current.answers = viewport.scrollTop;
      jump.current = null;
    }
  }, [expanded, directory]);
  const goTo = (id: string) => {
    jump.current = id;
    setCurrent(id);
    setExpanded(previous => new Set(previous).add(id));
    setDirectory(false);
  };
  const index = <nav className="review-directory" aria-label={tr("问题列表")}>{answers.map((answer, i) => <button key={answer.questionId} aria-current={current === answer.questionId ? "location" : undefined} onClick={() => goTo(answer.questionId)}>
    <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span><span>{answer.question}</span></button>)}</nav>;
  const updatePosition = () => {
    const viewport = scroll.current;
    if (!viewport) return;
    positions.current[tab] = viewport.scrollTop;
    remember();
    if (tab !== "answers") return;
    const top = viewport.getBoundingClientRect().top + 48;
    const items = [...viewport.querySelectorAll<HTMLElement>("[data-question-id]")];
    const closest = items.filter(item => item.getBoundingClientRect().top <= top).at(-1) ?? items[0];
    if (closest?.dataset.questionId) setCurrent(closest.dataset.questionId);
  };
  return <Tabs value={tab} onValueChange={changeTab} className="review-tabs min-h-0 flex-1 gap-0">
    <div className="review-toolbar">{leading}<TabsList><TabsTrigger value="answers">{tr("问答")}</TabsTrigger><TabsTrigger value="transcripts" aria-label={tr("完整转写")}>{tr("转写")}</TabsTrigger></TabsList>
      <div className="review-toolbar-actions">{quietTitle&&<TooltipHint label={quietTitle}><span className="review-context-title">{quietTitle}</span></TooltipHint>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" data-review-actions aria-label={tr("复盘操作")} ref={directoryTrigger}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent className="review-menu" aria-describedby={infoId}>{tab==="answers"&&!!answers.length&&<DropdownMenuItem onSelect={()=>setDirectory(true)}><List/>{tr("问题目录")}</DropdownMenuItem>}{tab === "answers" && !!answers.length && <><DropdownMenuItem onSelect={() => setExpanded(allExpanded?new Set():new Set(answers.map(item=>item.questionId)))}>{allExpanded?<ChevronsDownUp/>:<ChevronsUpDown/>}{allExpanded?tr("收起全部答案"):tr("展开全部答案")}</DropdownMenuItem><DropdownMenuSeparator /></>}
            <DropdownMenuItem disabled={!!s.busy || !s.data.sessions.some(item => item.id === review.session?.id)} onSelect={() => void s.exportHistory(sessionId)}><Download />{tr("导出 Markdown")}</DropdownMenuItem>
            {onDelete&&<DropdownMenuItem className="text-destructive" disabled={deleteDisabled} onSelect={onDelete}><Trash2/>{tr("删除记录")}</DropdownMenuItem>}
            {review.session && <><DropdownMenuSeparator /><DropdownMenuLabel className="review-menu-metadata"><ReviewSessionInfo session={review.session} id={infoId} /></DropdownMenuLabel></>}
          </DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <TabsContent forceMount hidden={tab !== "answers"} value="answers" className="review-tab-content mt-0 flex min-h-0 flex-1 flex-col"><div className="review-layout">
      <div ref={tab === "answers" ? scroll : undefined} className="review-reading-scroll" tabIndex={0} aria-label={tr("复盘内容")} onScroll={updatePosition}>
        <div className={`review-document${answers.length ? "" : " review-empty-document"}`}>{answers.length ? answers.map((answer,index) => <ReviewAnswer key={answer.questionId} answer={answer} index={index} store={s} expanded={expanded.has(answer.questionId)} toggle={() => setExpanded(previous => { const next = new Set(previous); if (next.has(answer.questionId)) next.delete(answer.questionId); else next.add(answer.questionId); return next; })} />) : <EmptyState compact brand title={tr("本场暂无参考答案")} />}</div>
      </div>
    </div></TabsContent>
    <TabsContent forceMount hidden={tab !== "transcripts"} value="transcripts" className="review-tab-content mt-0 flex min-h-0 flex-1 flex-col"><div ref={tab === "transcripts" ? scroll : undefined} className="review-reading-scroll" tabIndex={0} aria-label={tr("完整转写内容")} onScroll={updatePosition}><div className={`review-document review-transcript-document${transcripts.length ? "" : " review-empty-document"}`}>{transcripts.length ? <TranscriptList items={review.transcripts} /> : <EmptyState compact brand title={tr("本场暂无转写")} />}</div></div></TabsContent>
    <Dialog open={directory} onOpenChange={setDirectory}><DialogContent className="review-directory-dialog" onCloseAutoFocus={event => { event.preventDefault(); directoryTrigger.current?.focus(); }}><DialogHeader><DialogTitle>{tr("问题目录")}</DialogTitle><DialogDescription>{tr("选择问题，定位并展开参考答案。")}</DialogDescription></DialogHeader>{index}</DialogContent></Dialog>
  </Tabs>;
}

export function ReviewWorkspace({ store: s }: { store: Copilot }) {
  useLocale();
  const { session, loading, error } = s.review;
  return <section className="review-workspace" aria-label={tr("面试复盘")}>
    {loading ? <div role="status" className="review-empty flex items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{tr("正在读取复盘…")}</div> :
      error ? <div className="p-6"><Notice error>{messageText(error)}</Notice><Button variant="outline" size="sm" className="mt-3" onClick={() => void s.loadReview(session)}>{tr("重试读取")}</Button></div> :
      !session ? <div className="review-empty"><EmptyState compact brand title={tr("暂无面试复盘")} description={tr("结束面试后，在这里查看复盘。")} /></div> : <ReviewDocument key={session.id} store={s} />}
  </section>;
}
