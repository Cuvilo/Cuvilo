import {t as tr, currentLocale, useLocale, messageText} from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ArrowLeft, ChevronLeft, ChevronRight, Download, ListChecks, MoreHorizontal, Search, Trash2 } from "lucide-react";
import type { Session } from "@/types";
import type { Copilot } from "@/hooks/use-copilot";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { EmptyState, Spinner, Notice } from "./common";
import { groupSessions, duplicateSessionNames, sessionDisplayTitle, sessionSearchTerms } from "@/lib/session-display";
import { TooltipHint } from "./ui/tooltip";
import { useReadingLayoutAnchor } from "@/hooks/use-reading-layout-anchor";
import { ReviewDocument } from "./review-workspace";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
const time=(at:number)=>new Date(at).toLocaleString(currentLocale(),{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
export function HistoryView({store:s}:{store:Copilot}) {
  useLocale();
  const [deleting,setDeleting]=useState<Session[]|null>(null),[deleteError,setDeleteError]=useState("");
  const [batch,setBatch]=useState(false),[selected,setSelected]=useState<Set<string>>(new Set());
  const [query,setQuery]=useState(s.historyMemory.current.query),[mobileDetail,setMobileDetail]=useState(false);
  const [indexCollapsed,setIndexCollapsed]=useState(s.historyMemory.current.collapsed),[narrow,setNarrow]=useState(false);
  const layout=useRef<HTMLDivElement|null>(null);
  const preserveReading=useReadingLayoutAnchor(layout);
  useLayoutEffect(()=>{const node=layout.current;if(!node)return;const update=()=>{const width=node.getBoundingClientRect().width;if(width>0)setNarrow(width<=760);};update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[s.data.sessions.length>0]);
  const toggleIndex=()=>preserveReading(()=>setIndexCollapsed(previous=>{s.historyMemory.current.collapsed=!previous;return !previous;}));
  const batchTrigger=useRef<HTMLButtonElement|null>(null);
  const deleteTrigger=useRef<HTMLElement|null>(null),historyIndex=useRef<HTMLDivElement|null>(null),backFocus=useRef(false);
  const normalized=query.trim().toLocaleLowerCase();
  const sorted=[...s.data.sessions].sort((a,b)=>b.createdAt-a.createdAt);
  const items=sorted.filter(item=>`${item.title} ${sessionSearchTerms(item)} ${time(item.createdAt)} ${new Date(item.createdAt).toLocaleDateString(currentLocale())}`.toLocaleLowerCase().includes(normalized));
  const eligible=items.filter(item=>item.id!==s.data.session?.id);
  const chosen=sorted.filter(item=>item.id!==s.data.session?.id&&selected.has(item.id));
  const session=sorted.find(item=>item.id===s.historyId);
  useEffect(()=>{if(s.loaded&&!s.historyId&&sorted.length)void s.history(sorted[0].id);},[s.loaded,s.historyId,sorted[0]?.id]);
  useEffect(()=>{s.historyMemory.current.query=query;},[query,s.historyMemory]);
  useLayoutEffect(()=>{if(historyIndex.current)historyIndex.current.scrollTop=s.historyMemory.current.listTop;},[mobileDetail,s.historyMemory]);
  useLayoutEffect(()=>{if(backFocus.current){historyIndex.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.focus();backFocus.current=false;}},[mobileDetail]);
  useEffect(()=>{setSelected(previous=>{const next=new Set([...previous].filter(id=>s.data.sessions.some(item=>item.id===id&&id!==s.data.session?.id)));return next.size===previous.size?previous:next;});},[s.data.sessions,s.data.session?.id]);
  const toggleSelected=(id:string)=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const groups=groupSessions(items);
  const duplicates=new Map(groupSessions(sorted).map(group=>[group.key,duplicateSessionNames(group.items)]));
  const batchAction=<TooltipHint label={batch?tr("完成"):tr("批量管理")}><Button className="history-batch-toggle" ref={batchTrigger} size="icon" aria-label={batch?tr("完成"):tr("批量管理")} variant={batch?"secondary":"outline"} disabled={!!s.busy||(!batch&&!sorted.length)} aria-pressed={batch} onClick={()=>{setBatch(value=>!value);setSelected(new Set());setMobileDetail(false);}}>{batch?<Check/>:<ListChecks/>}</Button></TooltipHint>;
  return <><h1 className="sr-only">{tr("历史记录")}</h1>
    {!sorted.length?<><div className="history-empty-tools">{batch&&batchAction}</div><div className="history-library-empty"><EmptyState compact brand title={tr("暂无面试记录")}/></div></>:<div ref={layout} className={cn("history-layout history-reader",indexCollapsed&&"history-index-collapsed",mobileDetail&&"history-show-detail",batch&&"history-batch")}>
      <aside id="history-session-index" className="history-index" aria-label={tr("面试记录列表")} inert={indexCollapsed&&!narrow} aria-hidden={indexCollapsed&&!narrow?true:undefined}>
        <div className="history-index-tools"><div className="history-search"><Search aria-hidden="true"/><Input aria-label={tr("搜索历史记录")} placeholder={tr("搜索记录")} value={query} onChange={e=>{setQuery(e.target.value);s.historyMemory.current.listTop=0;if(historyIndex.current)historyIndex.current.scrollTop=0;}}/></div>{batchAction}</div>
        {batch&&<div className="history-select-all"><label><Checkbox aria-label={tr("全选可删除记录")} checked={eligible.length>0&&eligible.every(item=>selected.has(item.id))} indeterminate={eligible.some(item=>selected.has(item.id))&&!eligible.every(item=>selected.has(item.id))} disabled={!!s.busy||!eligible.length} onChange={e=>setSelected(previous=>{const next=new Set(previous);for(const item of eligible){if(e.target.checked)next.add(item.id);else next.delete(item.id);}return next;})}/>{tr("全选")}</label><span>{tr("已选")}{" "}{chosen.length}{" "}{tr("条")}</span></div>}
        <div ref={historyIndex} tabIndex={-1} className="history-sessions" onScroll={e=>{s.historyMemory.current.listTop=e.currentTarget.scrollTop;}}>
          {groups.length?groups.map(group=><section key={group.key} className="history-date-group"><h2>{group.label}</h2>{group.items.map(item=><div key={item.id} className={cn("history-row",s.historyId===item.id&&"history-row-selected")}>
            {batch&&<Checkbox aria-label={tr("选择记录：{0}", item.title)} checked={selected.has(item.id)} disabled={!!s.busy||s.data.session?.id===item.id} onChange={()=>toggleSelected(item.id)}/>}
            <TooltipHint label={`${item.title} · ${time(item.createdAt)}`} side="right"><button type="button" className="history-row-open" aria-current={s.historyId===item.id?true:undefined} disabled={batch&&(!!s.busy||s.data.session?.id===item.id)} onClick={()=>{if(batch)toggleSelected(item.id);else{if(s.historyId!==item.id)void s.history(item.id);setMobileDetail(true);}}}><strong>{sessionDisplayTitle(item)}</strong>{duplicates.get(group.key)?.has(sessionDisplayTitle(item))&&<time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString(currentLocale(),{hour:"2-digit",minute:"2-digit"})}</time>}{s.data.session?.id===item.id&&<span className="history-live-dot" role="img" aria-label={tr("进行中")}/>}</button></TooltipHint>
            {!batch&&<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="history-row-more" data-history-actions={item.id} aria-label={tr("记录操作：{0}", item.title)}><MoreHorizontal/></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem disabled={!!s.busy} onSelect={()=>void s.exportHistory(item.id)}><Download/>{tr("导出 Markdown")}</DropdownMenuItem><DropdownMenuItem disabled={!!s.busy||s.data.session?.id===item.id} className="text-destructive" onSelect={()=>{deleteTrigger.current=[...document.querySelectorAll<HTMLElement>("[data-history-actions]")].find(el=>el.dataset.historyActions===item.id)??null;setDeleteError("");setDeleting([item]);}}><Trash2/>{tr("删除记录")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
          </div>)}</section>):<h2 className="history-no-results">{tr("没有匹配的记录")}</h2>}
        </div>
        {batch&&<div className="history-batch-actions"><Button variant="destructive" size="sm" disabled={!!s.busy||!chosen.length} onClick={e=>{deleteTrigger.current=e.currentTarget;setDeleteError("");setDeleting(chosen);}}>{tr("删除所选")}{chosen.length?`（${chosen.length}）`:""}</Button></div>}
      </aside>
      <TooltipHint label={indexCollapsed?tr("展开记录列表"):tr("收起记录列表")} side="right"><button type="button" className="history-index-handle" aria-label={indexCollapsed?tr("展开记录列表"):tr("收起记录列表")} aria-controls="history-session-index" aria-expanded={!indexCollapsed} onClick={toggleIndex}>{indexCollapsed?<ChevronRight/>:<ChevronLeft/>}</button></TooltipHint>
      <section className="history-detail" aria-label={tr("历史复盘")}>
        {s.historyLoading?<div role="status" className="history-reading-status"><Spinner/>{tr("正在读取…")}</div>:s.historyError?<div className="p-6"><Notice error>{s.historyError}</Notice><Button variant="outline" size="sm" className="mt-3" onClick={()=>void s.history(s.historyId)}>{tr("重试读取")}</Button></div>:session?<ReviewDocument key={session.id} store={s} review={{session,...s.historyData}} memory={s.historyMemory.current.reading} quietTitle={sessionDisplayTitle(session)} leading={<Button variant="ghost" size="icon-sm" className="history-back" aria-label={tr("返回记录列表")} onClick={()=>{backFocus.current=true;setMobileDetail(false);}}><ArrowLeft/></Button>} deleteDisabled={!!s.busy||s.data.session?.id===session.id} onDelete={()=>{deleteTrigger.current=document.querySelector<HTMLElement>('[data-review-actions]');setDeleteError("");setDeleting([session]);}}/>:null}
      </section>
    </div>}
      <AlertDialog open={!!deleting} onOpenChange={open => {if (!open) { setDeleting(null); setDeleteError(""); }}}>
        <AlertDialogContent onCloseAutoFocus={event => {
          event.preventDefault();
          if (deleteTrigger.current?.isConnected && !deleteTrigger.current.matches(":disabled")) deleteTrigger.current.focus();
          else (historyIndex.current??batchTrigger.current)?.focus();
        }}>
          <AlertDialogHeader><AlertDialogTitle>{deleting && deleting.length > 1 ? tr("删除这 {0} 条记录？", deleting.length) : tr("删除这条记录？")}</AlertDialogTitle>
            <AlertDialogDescription>{deleting?.length === 1 ? `“${deleting[0].title}”` : tr("所选 {0} 条记录", deleting?.length ?? 0)}{tr("的问答和转写将一并删除，无法撤销。")}</AlertDialogDescription></AlertDialogHeader>
          {deleteError && <p role="alert" className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{messageText(deleteError)}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={!!s.busy}>{tr("取消")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!!s.busy} onClick={async event => {
              event.preventDefault();
              if (!deleting) return;
              const result = await s.deleteHistory(batch ? deleting.map(item => item.id) : deleting[0].id);
              if (result.ok) { setDeleting(null); setSelected(new Set()); }
              else setDeleteError(result.error);
            }}>{tr("删除记录")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>;
}
