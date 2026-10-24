import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AudioLines, Cable, Check, ChevronDown, ArrowLeft, Info, Keyboard, Search, Sparkles, SlidersHorizontal, ScanText, Plus, Archive, RotateCcw } from "lucide-react";
import { providerPresets, createProvider, youdaoFreeOcr, providerDisplayName, isOcrProvider, type ServiceGroup, existingPreset } from "@/lib/provider-presets";
import { UpdateControls } from "./app-updater";
import type { AppUpdater } from "@/hooks/use-app-updater";
import type { Copilot } from "@/hooks/use-copilot";
import {useOcrStatus} from "@/hooks/use-ocr-status";
import { useDataTools, useWindowMemory } from "@/hooks/use-data-tools";
import { shortcutConflicts, shortcutLabels, manualShortcut } from "@/lib/shortcut-validation";
import { version as sourceVersion } from "../../package.json";
import {useAutostart} from "@/hooks/use-autostart";
import { type CatalogCache } from "./model-picker";
import {AnswerWordsInput} from "./answer-words-input";
import { ProviderFields, ProviderActions } from "./settings-provider";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Field, PageHeader, Spinner } from "./common";

const sections=[
 {id:"services",label:"服务",icon:Cable,words:"模型 语音 OCR 截图 识别 密钥 API Key App ID RTasr 讯飞 腾讯 DeepSeek URL"},
 {id:"reading",label:"偏好",icon:SlidersHorizontal,words:"常规 主题 外观 深色 浅色 系统 启动 开机 自启动 关闭 托盘 网络 代理 字号 停顿 回答 阅读 窗口 位置 尺寸 确认 共享 隐私 保护"},
 {id:"shortcuts",label:"快捷键",icon:Keyboard,words:"回答 停止 显示 收起 答案 冲突 截图 手动提问 停用 默认"},
 {id:"privacy",label:"数据",icon:Archive,words:"备份 恢复 材料 历史"},
 {id:"about",label:"关于",icon:Info,words:"Cuvilo 版本 更新"},
];
function ShortcutInput({id,value,onChange,invalid,describedBy}:{id:string;value:string;onChange:(value:string)=>void;invalid:boolean;describedBy?:string}) {
  return <Input id={id} readOnly value={value} placeholder="未启用" aria-invalid={invalid} aria-describedby={describedBy} className="font-mono text-xs" onKeyDown={event=>{
    if(event.key==="Tab" || event.key==="Escape")return;
    event.preventDefault();event.stopPropagation();
    if(!event.ctrlKey&&!event.altKey)return;
    if(["ControlLeft","ControlRight","AltLeft","AltRight","ShiftLeft","ShiftRight","MetaLeft","MetaRight"].includes(event.code))return;
    const key=event.code.replace(/^Key/,"").replace(/^Digit/,"");
    if(key)onChange([event.ctrlKey?"Ctrl":"",event.altKey?"Alt":"",event.shiftKey?"Shift":"",key].filter(Boolean).join("+"));
  }}/>;
}
export function SettingsView({store:s,serviceOnly,onServiceClose,updates}:{store:Copilot;serviceOnly?:ServiceGroup;onServiceClose?:()=>void;updates?:AppUpdater}) {
  const [section,setSection]=useState("services"),[query,setQuery]=useState(""),[expanded,setExpanded]=useState(serviceOnly??""),[version,setVersion]=useState(sourceVersion);
  const catalogCache=useRef<CatalogCache>(new Map());
  const ocr=useOcrStatus(s.native);
  const [ocrTested,setOcrTested]=useState(false);
  const startup=useAutostart(s.native),serviceReturn=useRef<HTMLButtonElement|null>(null);
  const [adding,setAdding]=useState<ServiceGroup|null>(null);
  const deleteReturn=useRef<HTMLButtonElement|null>(null);
  const [deleting,setDeleting]=useState<string|null>(null),[deleteError,setDeleteError]=useState("");
  const memory=useWindowMemory(s.native),tools=useDataTools(s),restoreTrigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{let alive=true;if(s.native)void getVersion().then(value=>{if(alive&&typeof value==="string")setVersion(value);}).catch(()=>{});return()=>{alive=false;};},[s.native]);
  const {draft}=s;
  const matches=sections.filter(item=>`${item.label} ${item.words} ${item.id==="services"?draft?.providers.map(p=>p.name).join(" ")??"":""}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(()=>{if(matches.length&&!matches.some(item=>item.id===section))setSection(matches[0].id);},[query,section,matches.map(item=>item.id).join("|")]);
  if(!s.loaded || !draft)return <div className="loading-page"><PageHeader title="设置"/><div className="flex items-center gap-2 text-muted-foreground"><Spinner/>正在读取已保存配置…</div></div>;
  const conflicts=shortcutConflicts(draft.shortcuts);
  const invalidFont=!Number.isInteger(draft.fontSize)||draft.fontSize<14||draft.fontSize>30;
  const invalidPause=!Number.isInteger(draft.silenceMs)||draft.silenceMs<300||draft.silenceMs>2000;
  const current=matches.some(item=>item.id===section)?section:matches[0]?.id??"";
  const updateNetwork=(patch:Partial<typeof draft.network>)=>{for(const p of draft.providers)s.clearTest(p.id);s.updatePreferences({network:{...draft.network,...patch}});};
  const categories=sections.find(item=>item.id===current);
  const addService=(presetId:string,target:ServiceGroup=adding??"ocr")=>{
    const provider=existingPreset(draft.providers,presetId)??createProvider(presetId,draft.providers);
    s.setDraft({...draft,providers:draft.providers.some(p=>p.id===provider.id)?draft.providers:[...draft.providers,provider],...(target==="model"?{activeModel:provider.id}:target==="asr"?{asrProvider:provider.id}:{ocrProvider:provider.id})});
    setExpanded(target);setAdding(null);
  };
  const groups=[{id:"model",title:"回答模型",selected:draft.activeModel,icon:Sparkles},{id:"asr",title:"语音识别",selected:draft.asrProvider,icon:AudioLines},{id:"ocr",title:"截图识别",selected:draft.ocrProvider??"local",icon:ScanText}] as const;
  const saveService=async(group:ServiceGroup)=>{if(await s.saveConfig(group)){if(serviceOnly){s.setHomeGuide("auto");setExpanded("");}}};
  const removeService=()=>{deleteReturn.current=document.activeElement as HTMLButtonElement;setDeleting(draft.providers.find(p=>p.id===groups.find(g=>g.id===expanded)?.selected)?.id??null);setDeleteError("");};
  return <>
    {!serviceOnly&&<>
    <h1 className="sr-only">设置</h1>
    <Tabs animated={false} orientation="vertical" value={current} onValueChange={value=>setSection(value)} className="settings-workspace">
      <aside className="settings-index"><div className="settings-search"><Search aria-hidden="true"/><Input aria-label="搜索设置" placeholder="搜索设置…" value={query} onChange={e=>setQuery(e.target.value)}/></div><TabsList className="settings-category-list" aria-label="设置分类">{matches.map(item=><TabsTrigger key={item.id} value={item.id}><item.icon aria-hidden="true"/>{item.label}</TabsTrigger>)}</TabsList></aside>
      <div className="settings-detail"><div className="settings-detail-inner settings-detail-summary">
        {categories && <h2 className="sr-only">{categories.label}</h2>}
        {!matches.length && <p className="text-sm text-muted-foreground" role="status">没有匹配的设置</p>}
        <TabsContent value="services" className="settings-section-content settings-services-list">
          {groups.map(group=>{const selected=group.id==="model"?s.data.settings.activeModel:group.id==="asr"?s.data.settings.asrProvider:s.data.settings.ocrProvider??"local";const provider=s.data.settings.providers.find(p=>p.id===selected);return <section key={group.id} className="settings-service"><h3 aria-label={group.title}><button type="button" className="settings-service-summary" aria-label={`配置${group.title}`} aria-haspopup="dialog" onClick={event=>{serviceReturn.current=event.currentTarget;setExpanded(group.id);setAdding(null);}}><span className="settings-service-icon"><group.icon/></span><span className="settings-service-name"><strong>{group.title}</strong><span>{group.id==="ocr"&&selected==="local"?"Windows OCR":group.id==="ocr"&&selected===youdaoFreeOcr.id?youdaoFreeOcr.name:provider?providerDisplayName(provider):"未选择"}</span></span><ChevronDown className="settings-service-chevron"/></button></h3></section>;})}

        </TabsContent>
        <TabsContent value="reading" className="settings-section-content">
          <section className="settings-preference-group"><h3>常规</h3>
            <div className="settings-option-row"><label htmlFor="autostart">开机启动</label><Switch id="autostart" checked={startup.enabled} disabled={!startup.loaded||startup.busy} onCheckedChange={value=>void startup.change(value)}/></div>
            {startup.error&&<div role="alert" className="settings-inline-error">{startup.error}{!startup.loaded&&<Button variant="ghost" size="xs" onClick={()=>void startup.retry()}>重试</Button>}</div>}
            <div className="settings-preference-list"><Field id="close-action" label="关闭主窗口时"><Select value={draft.closeAction??"tray"} onValueChange={closeAction=>s.updatePreferences({closeAction:closeAction as "tray"|"quit"})}><SelectTrigger id="close-action"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="tray">收起到托盘</SelectItem><SelectItem value="quit">退出程序</SelectItem></SelectContent></Select></Field></div>
          </section>
          <section className="settings-preference-group"><h3>外观</h3><div className="settings-theme-picker" role="group" aria-label="主题">{([{id:"light",name:"浅色"},{id:"dark",name:"深色"},{id:"system",name:"跟随系统"}] as const).map(item=><button type="button" key={item.id} aria-pressed={(draft.theme??"light")===item.id} onClick={()=>s.updatePreferences({theme:item.id})}><span className={`theme-swatch theme-swatch-${item.id}`} aria-hidden="true"><i/><i/><i/></span><span>{item.name}</span></button>)}</div></section>
          <section className="settings-preference-group"><h3>面试与阅读</h3>

          <div className="settings-preference-list"><Field id="silence" label="回答延迟 · ms"><Input id="silence" aria-invalid={invalidPause} type="number" min={300} max={2000} value={draft.silenceMs} onChange={e=>s.updatePreferences({silenceMs:Number(e.target.value)})}/></Field><Field id="answer-words" label="生成字数"><AnswerWordsInput store={s} id="answer-words"/></Field><Field id="fontsize" label="答案字号"><Input id="fontsize" aria-invalid={invalidFont} type="number" min={14} max={30} value={draft.fontSize} onChange={e=>s.updatePreferences({fontSize:Number(e.target.value)})}/></Field></div>
          {(invalidFont||invalidPause)&&<p role="alert" className="settings-inline-error">{invalidFont?"答案字号应在14–30px之间。":"停顿时间应在300–2000ms之间。"}</p>}
          <div className="settings-option-row"><label htmlFor="answer-opacity">背景透明度</label><div className="settings-opacity-control"><input id="answer-opacity" aria-label="背景透明度" type="range" min={0} max={80} step={1} value={100-s.answerOpacity} onChange={e=>s.updatePreferences({answerOpacity:100-Number(e.target.value)})}/><output htmlFor="answer-opacity">{100-s.answerOpacity}%</output></div></div>
          <div className="settings-option-row"><label htmlFor="screen-confirm">截图后确认题目</label><Switch id="screen-confirm" checked={draft.screenCapture?.confirmBeforeAnswer??false} onCheckedChange={value=>s.updatePreferences({screenCapture:{shiftDoubleClick:false,confirmBeforeAnswer:value}})}/></div>
          <div className="settings-option-row"><label htmlFor="remember-answer">记住答案窗位置与大小</label><Switch aria-label="记住答案窗位置与大小" id="remember-answer" checked={memory.remember} disabled={!memory.loaded||memory.busy||!!s.data.session} onCheckedChange={value=>void memory.change(value)}/></div>{memory.error&&<p role="alert" className="settings-inline-error">{memory.error}</p>}
          <div className="settings-option-row"><label htmlFor="capture-protection">共享时隐藏 Cuvilo</label><Switch aria-label="共享时隐藏 Cuvilo" id="capture-protection" checked={draft.captureProtection} disabled={s.busy==="settings"} onCheckedChange={captureProtection=>s.updatePreferences({captureProtection})}/></div>
          {s.native&&s.data.captureProtection?.state==="blocked"&&<p role="alert" className="settings-inline-error">保护未生效，窗口已收起。</p>}
          </section>
          <section className="settings-preference-group"><h3>网络</h3><div className="settings-preference-list pt-4"><Field id="proxy-mode" label="代理"><Select value={draft.network.mode} onValueChange={mode=>updateNetwork({mode})}><SelectTrigger id="proxy-mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="system">跟随系统</SelectItem><SelectItem value="direct">直接连接</SelectItem><SelectItem value="manual">手动代理</SelectItem></SelectContent></Select></Field>{draft.network.mode==="manual"&&<Field id="proxy-url" label="地址"><Input id="proxy-url" value={draft.network.url} placeholder="http://127.0.0.1:7890" onChange={e=>updateNetwork({url:e.target.value})}/></Field>}</div></section>
        </TabsContent>
        <TabsContent value="shortcuts" className="settings-section-content"><div className="settings-preference-list">{Object.entries({answer:draft.shortcuts.answer,cancel:draft.shortcuts.cancel,toggle:draft.shortcuts.toggle,screen:draft.shortcuts.screen??"Ctrl+Shift+S",manual:manualShortcut(draft.shortcuts)}).map(([id,value])=><div key={id}><Field id={`shortcut-${id}`} label={shortcutLabels[id]??id}><div className="flex gap-2"><ShortcutInput id={`shortcut-${id}`} value={value} invalid={!!conflicts[id]} describedBy={conflicts[id]?`conflict-${id}`:undefined} onChange={value=>s.updatePreferences({shortcuts:{...draft.shortcuts,[id]:value}})}/><Button variant="ghost" size="sm" disabled={!value} aria-label={`停用${shortcutLabels[id]??id}快捷键`} onClick={()=>s.updatePreferences({shortcuts:{...draft.shortcuts,[id]:""}})}>停用</Button></div></Field>{conflicts[id]&&<p id={`conflict-${id}`} role="alert" className="settings-inline-error">{conflicts[id]}</p>}</div>)}</div><div className="flex justify-end"><Button variant="ghost" size="sm" onClick={()=>s.updatePreferences({shortcuts:{answer:"Ctrl+Enter",cancel:"Ctrl+Shift+X",toggle:"Ctrl+Shift+H",screen:"Ctrl+Shift+S",manual:"Ctrl+Shift+M"}})}>恢复默认快捷键</Button></div></TabsContent>
        <TabsContent value="privacy" className="settings-section-content"><section className="settings-plain-group"><div className="settings-option-row"><div>备份</div><Button variant="outline" size="sm" disabled={tools.busy||!!s.busy||!!s.data.session} onClick={()=>void tools.create()}><Archive/>创建备份</Button></div><div className="settings-option-row"><div>恢复</div><Button ref={restoreTrigger} variant="outline" size="sm" disabled={tools.busy||!!s.busy||!!s.data.session} onClick={()=>void tools.choose()}><RotateCcw/>选择备份</Button></div>{s.data.session&&<p className="settings-footnote">请先结束面试，再备份或恢复数据。</p>}{tools.busy&&<p role="status" className="settings-footnote">正在处理数据…</p>}{tools.error&&!tools.preview&&<p role="alert" className="settings-inline-error">{tools.error}</p>}</section>
        </TabsContent>
        <TabsContent value="about" className="settings-section-content"><h3 className="text-base font-medium">Cuvilo</h3><div className="settings-option-row"><span>当前版本</span><span>{version}</span></div>{updates&&<UpdateControls updates={updates}/>}</TabsContent>
        {s.preferences.error&&<div className="settings-inline-error" role="alert">{s.preferences.error}<Button size="sm" variant="ghost" onClick={()=>void s.preferences.retry()}>重试</Button></div>}
      </div></div>
    </Tabs>
    </>}
    <Dialog open={!!expanded} onOpenChange={open=>{if(!open){setExpanded("");setAdding(null);}}}><DialogContent className="settings-service-dialog" onEscapeKeyDown={event=>{if(adding){event.preventDefault();setAdding(null);}}} onCloseAutoFocus={event=>{event.preventDefault();if(serviceOnly)onServiceClose?.();else serviceReturn.current?.focus();}}>
      {groups.filter(group=>group.id===expanded).map(group=>{const provider=draft.providers.find(p=>p.id===group.selected),providers=draft.providers.filter(p=>group.id==="model"?p.kind==="llm":group.id==="ocr"?isOcrProvider(p):["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(p.kind));return <section className="settings-service-dialog-section" key={group.id}>
        <DialogHeader><div className="settings-service-dialog-title">{adding&&<Button variant="ghost" size="icon-sm" aria-label="返回配置" onClick={()=>setAdding(null)}><ArrowLeft/></Button>}<DialogTitle>{adding?"添加":""}{group.title}</DialogTitle></div><DialogDescription className="sr-only">配置服务、检测连接并保存。关闭后保留未保存草稿。</DialogDescription></DialogHeader>
        <div className="settings-service-dialog-body">{adding?<div className="settings-preset-list">{providerPresets.filter(p=>p.group===adding).map(p=><Button key={p.id} variant="ghost" onClick={()=>addService(p.id)}>{p.name}{existingPreset(draft.providers,p.id)?<Check aria-label="已添加"/>:<Plus/>}</Button>)}</div>:<>
          <div className="settings-provider-selector"><Select value={group.selected} onValueChange={value=>s.setDraft({...draft,[group.id==="model"?"activeModel":group.id==="asr"?"asrProvider":"ocrProvider"]:value})}><SelectTrigger disabled={providers.length===0&&group.id!=="ocr"} aria-label={group.id==="model"?"当前模型服务":group.id==="asr"?"当前服务":"OCR 服务"}><SelectValue placeholder="选择服务"/></SelectTrigger><SelectContent>{group.id==="ocr"&&<><SelectItem value="local">本地 · Windows OCR</SelectItem><SelectItem value={youdaoFreeOcr.id}>{youdaoFreeOcr.name}</SelectItem></>}{providers.map((p,index)=><SelectItem key={p.id} value={p.id}>{providerDisplayName(p)}{providers.filter(other=>other.name===p.name).length>1?` · ${index+1}`:""}</SelectItem>)}</SelectContent></Select><Button variant="ghost" size="icon-sm" aria-label={`添加${group.title}服务`} onClick={()=>setAdding(group.id)}><Plus/></Button></div>
          {provider&&<><ProviderFields key={provider.id} store={s} provider={provider} group={group.id} onRemove={removeService} actions={false} catalogCache={catalogCache}/></>}
        </>}</div>
        {!adding&&<DialogFooter>{provider?<ProviderActions store={s} provider={provider} group={group.id} onRemove={removeService} onSave={()=>void saveService(group.id)}/>:group.id==="ocr"&&group.selected===youdaoFreeOcr.id?<ProviderActions store={s} provider={youdaoFreeOcr} group="ocr" onSave={()=>void saveService("ocr")}/>:group.id==="ocr"&&group.selected==="local"?<><Button variant="outline" size="sm" disabled={!s.native||ocr.checking} onClick={()=>{setOcrTested(true);ocr.retry();}}>检测</Button>{ocrTested&&<p role="status" className={ocr.status?.available?"settings-test-inline text-muted-foreground":"settings-test-inline text-destructive"}>{ocr.checking?"正在检测…":ocr.status?.available?"本地识别可用":ocr.status?.message??"检测失败"}</p>}<Button size="sm" className="ml-auto" disabled={!!s.busy||!s.serviceDirty("ocr")} onClick={()=>void saveService("ocr")}><Check/>保存</Button></>:null}</DialogFooter>}
      </section>;})}
    </DialogContent></Dialog>
    <AlertDialog open={!!deleting} onOpenChange={open=>{if(!open&&s.busy!=="remove-provider")setDeleting(null);}}><AlertDialogContent onEscapeKeyDown={e=>{if(s.busy==="remove-provider")e.preventDefault();}} onCloseAutoFocus={e=>{e.preventDefault();if(deleteReturn.current?.isConnected)deleteReturn.current.focus();else document.querySelector<HTMLButtonElement>('.settings-service-dialog [role=combobox]:not(:disabled),.settings-service-dialog button[aria-label^="添加"]')?.focus();}}><AlertDialogHeader><AlertDialogTitle>删除这个服务？</AlertDialogTitle><AlertDialogDescription>移除此服务和密钥。</AlertDialogDescription></AlertDialogHeader>{deleteError&&<p role="alert" className="settings-inline-error">{deleteError}</p>}<AlertDialogFooter><AlertDialogCancel disabled={s.busy==="remove-provider"}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={!!s.busy} onClick={e=>{e.preventDefault();if(deleting)void s.removeProvider(deleting).then(result=>{if(result.ok)setDeleting(null);else setDeleteError(result.error);});}}>删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!tools.preview} onOpenChange={open=>{if(!open)tools.close();}}><AlertDialogContent className="settings-restore-dialog max-h-[calc(100dvh-48px)] overflow-y-auto" onEscapeKeyDown={e=>{if(tools.busy)e.preventDefault();}} onCloseAutoFocus={e=>{e.preventDefault();restoreTrigger.current?.focus();}}><AlertDialogHeader><AlertDialogTitle>恢复这份备份？</AlertDialogTitle><AlertDialogDescription>{tools.preview&&<>备份时间：{new Date(tools.preview.createdAt).toLocaleString("zh-CN")}<br/>{tools.preview.materials} 份材料 · {tools.preview.sessions} 场面试 · {tools.preview.answers} 条答案 · {tools.preview.transcripts} 条转写<br/><br/></>}恢复将替换当前全部材料和面试记录。当前数据会先自动备份，服务配置与密钥保持原样。</AlertDialogDescription></AlertDialogHeader>{tools.error&&<p role="alert" className="settings-inline-error">{tools.error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={tools.busy}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={tools.busy} onClick={e=>{e.preventDefault();void tools.restore();}}>{tools.busy?<Spinner/>:<RotateCcw/>}确认恢复</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
