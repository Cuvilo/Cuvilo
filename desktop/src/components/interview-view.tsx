import {materialKinds} from "@/lib/material-kinds";
import {setupStatus} from "@/lib/setup-status";
import {SettingsView} from "./settings-view";
import { Popover } from "radix-ui";
import { sessionDisplayTitle } from "@/lib/session-display";
import { useEffect, useRef, useState } from "react";
import { Check, X, MoreHorizontal, ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, ChevronUp, ChevronRight, FileText, FolderOpen, Mic, Monitor, Play, RefreshCw, Volume2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { Copilot } from "@/hooks/use-copilot";
import type { Session } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { IconButton, Notice, Spinner } from "./common";
import { BrandMark } from "./brand-mark";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { MaterialDropZone } from "./material-drop-zone";
import { ReviewWorkspace } from "./review-workspace";
import { TooltipHint } from "./ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
const roles=["软件开发工程师","前端工程师","后端工程师","全栈工程师","算法工程师","测试工程师","数据分析师","产品经理","UI / UX 设计师","运维工程师"];

export function AudioMeter({ store: s, onPassed }: { store: Copilot; onPassed?: (sourceId: string) => void }) {
  const [passed, setPassed] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setPassed(false);
    return () => { revision.current++; };
  }, [s.sourceId]);
  useEffect(() => {
    if (!passed) return;
    const timer = setTimeout(() => setPassed(false), 2000);
    return () => clearTimeout(timer);
  }, [passed]);
  const level = Math.round(Math.min(100, (s.levels.meeting ?? 0) * 250));
  return <div className="audio-meter">
    <Volume2 className="size-4 shrink-0 text-muted-foreground" />
    <div className="meter-track" role="progressbar" aria-label="会议音量" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${level}%` }} />
    </div>
    <Button variant="ghost" size="xs" className="audio-test-button" disabled={!s.sourceId || !!s.data.session || !!s.busy}
      onClick={() => void s.action("audio", async () => {
        const current = ++revision.current;
        setPassed(false);
        await invoke("test_audio", { source: s.sources.find(source => source.id === s.sourceId) });
        if (current === revision.current) { setPassed(true); onPassed?.(s.sourceId); }
      })}>{s.busy === "audio" ? <Spinner /> : passed ? "检测通过" : "检测声音"}</Button>
  </div>;
}

const date = (at: number) => new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function reviewTitle(session: Session | null) {
  const title = session?.title.trim();
  return !title || /^面试\s*·\s*\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(title) ? "面试复盘" : title;
}

export function InterviewView({ store: s }: { store: Copilot }) {
  const [nameOpen,setNameOpen]=useState(false);
  const nameContent = useRef<HTMLDivElement | null>(null);
  const guideTrigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"audio" | "materials">("audio");
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogContent = useRef<HTMLDivElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const importAfterClose = useRef<true | string[] | null>(null);
  const openDialog = (kind: "audio" | "materials") => {
    dialogTrigger.current = document.activeElement as HTMLElement;
    setDialog(kind);
    setDialogOpen(true);
  };
  const manageMaterials = () => { setDialogOpen(false); s.setView("materials"); };
  const active = !!s.data.session;
  const locked = active || !!s.busy;
  const source = s.sources.find(item => item.id === s.sourceId);
  const materials = s.data.materials.filter(item => item.enabled);
  const reviewing = s.workspace === "review" && !active;
  const recent = s.data.sessions.filter(item => item.endedAt != null && item.id !== s.data.session?.id)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  const openReview = (session: Session) => {
    if (s.review.session?.id !== session.id) void s.loadReview(session, true);
    s.setWorkspace("review");
  };
  const ready=setupStatus(s.data);
  const missing=!ready.model||!ready.asr;
  const showGuide=s.loaded&&!active&&(s.homeGuide==="open"||(s.homeGuide!=="hidden"&&(missing||s.homeAudioPending)));
  const audioReady = !!s.sourceId && s.audioCheckedSource === s.sourceId;
  const serviceTrigger=useRef<HTMLElement|null>(null);
  const openService=(group:"model"|"asr")=>{serviceTrigger.current=document.activeElement as HTMLElement;s.setDraft(old=>old??structuredClone(s.data.settings));s.setHomeService(group);};
  const closeService=()=>{s.setHomeService(null);requestAnimationFrame(()=>{if(serviceTrigger.current?.isConnected)serviceTrigger.current.focus({preventScroll:true});else guideTrigger.current?.focus({preventScroll:true});});};
  const start = <Button variant="primary" size="sm" disabled={locked || !s.loaded || !s.sourceId} onClick={() => void s.begin()}>
    {s.busy === "start" ? <Spinner /> : <Play />}开始面试</Button>;
  return <>
    {reviewing && <header className="page-header interview-page-header">
      <div className="interview-page-heading">
        <IconButton label="返回面试" className="review-back" onClick={() => s.setWorkspace("prepare")}><ArrowLeft /></IconButton>
        <TooltipHint label={reviewTitle(s.review.session)}><h1 className="review-context-title">{reviewTitle(s.review.session)}</h1></TooltipHint>
      </div>
      <div className="flex shrink-0 items-center gap-2">{start}</div>
    </header>}
    {s.notices.some(item => item.error) && <div className="workbench-notices">{s.notices.filter(item => item.error).map(item => <Notice key={item.source} error>{item.message}</Notice>)}</div>}
    {reviewing ? <ReviewWorkspace store={s} /> : <div className="preparation-scroll">
      <section className="preparation-content" aria-label="会前准备">
        <header className="preparation-page-heading">
          <h1>会前准备</h1>
          <Button ref={guideTrigger} variant="ghost" size="xs" className="preparation-section-action preparation-guide-toggle" aria-expanded={showGuide} aria-controls="home-setup-guide" disabled={locked || !s.loaded} onClick={() => s.setHomeGuide(showGuide ? "hidden" : "open")}>使用引导{showGuide ? <ChevronUp/> : <ChevronDown/>}</Button>
        </header>
        <div className="preparation-setup">
        <header className="interview-page-header preparation-card-heading">
        <div className="preparation-role"><Label className="sr-only" htmlFor="interview-job">目标岗位</Label><div className="preparation-role-input">
          <span className="home-role-editor"><span className="home-role-measure" aria-hidden="true">{(s.draft??s.data.settings).job||"选择或输入岗位"}</span><Input id="interview-job" value={(s.draft??s.data.settings).job} placeholder="选择或输入岗位" disabled={locked} onChange={event=>s.updatePreferences({job:event.target.value})}/></span>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="选择常用岗位" disabled={locked}><ChevronDown/></Button></DropdownMenuTrigger><DropdownMenuContent className="role-presets">{roles.map(role=><DropdownMenuItem key={role} onSelect={()=>s.updatePreferences({job:role})}>{role}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        </div></div>
        <div className="preparation-actions"><Popover.Root open={nameOpen} onOpenChange={setNameOpen}><TooltipHint label="面试名称"><Popover.Trigger asChild><Button variant="ghost" size="icon-sm" aria-label="本次面试选项" disabled={locked}><MoreHorizontal/></Button></Popover.Trigger></TooltipHint><Popover.Portal><Popover.Content className="preparation-name-popover menu-surface" aria-label="面试名称" ref={nameContent} tabIndex={-1} onOpenAutoFocus={event=>{event.preventDefault();nameContent.current?.focus({preventScroll:true});}} sideOffset={8} align="end" collisionPadding={16}><Label htmlFor="session-title">会话名称</Label><Input id="session-title" className="h-8" placeholder="可选" value={s.title} disabled={locked} onChange={event=>s.setTitle(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing)setNameOpen(false);}}/></Popover.Content></Popover.Portal></Popover.Root>{start}</div>
        </header>
        {showGuide&&<section id="home-setup-guide" className="preparation-guide" aria-label="首次使用引导">
          <div className="preparation-guide-heading"><h2>{missing ? "首次使用" : "使用引导"}</h2><Button variant="ghost" size="xs" aria-label="稍后配置" onClick={()=>s.setHomeGuide("hidden")}>稍后<X/></Button></div>
          {([{id:"model",title:"连接回答模型",action:"连接模型",ready:ready.model},{id:"asr",title:"连接语音识别",action:"连接语音",ready:ready.asr}] as const).map((item,index)=><div key={item.id} className="preparation-guide-row"><span className="preparation-step-number" aria-hidden="true">{item.ready?<Check/>:index+1}</span><span>{item.title}</span><Button variant={item.ready?"ghost":"outline"} size="sm" disabled={locked} className={item.ready?"preparation-configured":undefined} onClick={()=>openService(item.id)}>{item.ready?<><Check/>已配置</>:<>{item.action}<ArrowRight/></>}</Button></div>)}
          <div className="preparation-guide-row"><span className="preparation-step-number" aria-hidden="true">{audioReady?<Check/>:3}</span><span>检测会议声音</span><Button variant={audioReady?"ghost":"outline"} size="sm" disabled={locked} className={audioReady?"preparation-configured":undefined} onClick={()=>openDialog("audio")}>{audioReady?<><Check/>已检测</>:<>检测声音<ArrowRight/></>}</Button></div>
        </section>}
        <div className="preparation-options">
          <Button variant="ghost" className="preparation-option" aria-label="调整会议音源" onClick={() => openDialog("audio")}>
            <Monitor /><span><span className="preparation-label">会议声音</span><span className="preparation-value">{source?.name ?? (s.loaded ? "尚未选择音源" : "正在读取…")}</span></span><ChevronRight /></Button>
          <Button variant="ghost" className="preparation-option" aria-label="转写我的回答" aria-pressed={s.microphone} disabled={locked} onClick={() => s.setMicrophone(!s.microphone)}>
            <Mic /><span><span className="preparation-label">本人转写</span><span className="preparation-value">{s.microphone ? "已开启" : "已关闭"}</span></span><span className="summary-switch" data-checked={s.microphone} /></Button>
          <Button variant="ghost" className="preparation-option" aria-label="查看启用材料" onClick={() => openDialog("materials")}>
            <FileText /><span><span className="preparation-label">个人材料</span><span className="preparation-value">{materials.length ? `${materials.length} 份已启用` : "添加材料"}</span></span><ChevronRight /></Button>
        </div>

        {s.preferences.status==="error"&&<div className="preparation-save-error" role="alert"><span>{s.preferences.error}</span><Button variant="ghost" size="xs" onClick={()=>void s.preferences.retry()}>重试</Button></div>}
        </div>
        {s.loaded && !showGuide && ((missing&&!active) || !source) && <div className="preparation-warning"><Notice>{missing ? "请先配置服务。" : "请选择会议音源。"}</Notice><Button variant="outline" size="sm" onClick={() => missing ? s.setHomeGuide("open") : openDialog("audio")}>{missing ? "配置服务" : "选择音源"}</Button></div>}
        <section className="recent-review" aria-label="最近面试">
          <div className="preparation-section-heading"><h2>最近面试</h2><Button variant="ghost" size="xs" className="preparation-section-action" onClick={() => s.setView("history")}>全部记录<ArrowUpRight /></Button></div>
          {recent.length ? <div className="recent-review-list">{recent.map((session,index)=><TooltipHint key={session.id} label={session.title}><Button variant="ghost" className="recent-review-row recent-review-link" aria-label={index===0?"继续复盘":`查看复盘：${session.title}`} disabled={active} onClick={()=>openReview(session)}><span className="recent-review-title">{sessionDisplayTitle(session)}</span><span className="recent-review-affordance">{index===0&&<span>继续复盘</span>}<ArrowRight/></span></Button></TooltipHint>)}</div> : <div className="preparation-empty"><BrandMark className="size-8"/><p>暂无面试记录</p></div>}


        </section>
      </section>
    </div>}
    {s.homeService&&<SettingsView store={s} serviceOnly={s.homeService} onServiceClose={closeService}/>}
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent ref={dialogContent} className="preparation-dialog flex flex-col gap-0 p-0" onOpenAutoFocus={event => {
        const target = dialogContent.current?.querySelector<HTMLElement>(dialog === "audio" ? "#audio-source:not(:disabled)" : "button[role=switch]:not(:disabled)");
        if (target) { event.preventDefault(); target.focus(); }
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        if (dialogTrigger.current?.isConnected) dialogTrigger.current.focus();
        else guideTrigger.current?.focus({preventScroll:true});
        if (importAfterClose.current) { const pending = importAfterClose.current; importAfterClose.current = null; if (pending === true) void s.importDoc(); else void s.importDropped(pending); }
      }}>
        <DialogHeader><DialogTitle>{dialog === "audio" ? "会议声音" : "个人材料"}</DialogTitle>
          <DialogDescription>{dialog === "audio" ? "选择会议音源并检测声音。" : `${materials.length} / ${s.data.materials.length} 份材料已启用，用于生成参考答案。`}</DialogDescription></DialogHeader>
        <div className="preparation-dialog-body">
          {dialog === "audio" ? <section className="audio-dialog-content">
            <Label htmlFor="audio-source">会议音源</Label>
            <div className="source-picker"><Select value={s.sourceId} onValueChange={s.setSourceId} disabled={locked || !s.loaded || !s.sources.length}>
              <SelectTrigger id="audio-source" aria-label="会议音源"><SelectValue placeholder="选择会议音源" /></SelectTrigger>
              <SelectContent>{s.sources.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{item.recommended ? " · 推荐" : ""}</SelectItem>)}</SelectContent>
            </Select><IconButton className="tool-button rounded-full bg-secondary" label="刷新音源" disabled={locked} onClick={() => void s.loadSources()}><RefreshCw /></IconButton></div>
            <p className="inspector-hint">{source?.kind === "system" ? "系统声音会采集所有应用的音频。" : source ? "仅采集所选应用声音" : "先打开腾讯会议并播放声音"}</p>
            <AudioMeter store={s} onPassed={sourceId => { s.setAudioCheckedSource(sourceId); if(ready.model&&ready.asr)s.setHomeGuide("auto"); }} />
          </section> : <MaterialDropZone store={s} disabled={locked} className="preparation-material-list" onDropPaths={paths => { importAfterClose.current = paths; setDialogOpen(false); }}>
            {s.data.materials.length ? s.data.materials.map(material => <div key={material.id} className="preparation-material-row">
              <FileText className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><Label htmlFor={`prepare-material-${material.id}`} className="preparation-material-title">{material.title}</Label><p>{materialKinds[material.kind] ?? "材料"}</p></div>
              <Switch id={`prepare-material-${material.id}`} aria-label={`用于回答：${material.title}`} checked={material.enabled} onCheckedChange={() => void s.toggleMaterial(material)} disabled={locked} />
            </div>) : <div className="preparation-material-empty"><FileText className="size-8" /><p>还没有个人材料</p></div>}
          </MaterialDropZone>}
        </div>
        <DialogFooter>{dialog === "audio" ? <Button variant="outline" onClick={() => setDialogOpen(false)}>完成</Button> : <>
          <Button variant="outline" disabled={locked} onClick={() => { importAfterClose.current = true; setDialogOpen(false); }}><FolderOpen />导入材料</Button>
          <Button variant="outline" onClick={manageMaterials}>管理材料<ArrowUpRight /></Button>
        </>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
