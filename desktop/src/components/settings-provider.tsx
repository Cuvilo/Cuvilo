import {t as tr, useLocale, messageText} from "@/i18n";
import {invoke} from "@tauri-apps/api/core";
import {providerHelp} from "@/lib/provider-help";
import { useRef } from "react";
import { ModelPicker, type CatalogCache } from "./model-picker";
import type { Copilot } from "@/hooks/use-copilot";
import { providerPresets, providerDisplayName, isCloudOcr, type ServiceGroup } from "@/lib/provider-presets";
import type { Provider } from "@/types";
import { Check, Trash2, Zap } from "lucide-react";
import { TooltipHint } from "./ui/tooltip";
import { SecretInput } from "@/SecretInput";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Label } from "./ui/label";
import { Field, Spinner } from "./common";

export function ProviderFields({store:s,provider:p,group,onRemove,actions=true, catalogCache}:{store:Copilot;provider:Provider;group:ServiceGroup;onRemove:()=>void;actions?:boolean;catalogCache?:React.RefObject<CatalogCache>}) {
  useLocale();
  const ownCache=useRef<CatalogCache>(new Map());
  const model=p.kind==="llm"||p.kind==="ocr", tencent=p.kind==="tencent";
  const openai=p.kind==="openai-asr", cloud=isCloudOcr(p), http=group!=="asr"||openai, youdao=p.kind==="youdao-ocr";
  const help=providerHelp(p), custom=group==="asr"&&p.id.startsWith("custom-asr-");
  const protocols=providerPresets.filter(item=>item.group==="asr"&&item.id!=="openai-asr");
  const switchProtocol=(kind:string)=>{
    if(s.data.settings.providers.some(item=>item.id===p.id))return;
    const preset=protocols.find(item=>item.kind===kind);if(!preset)return;
    s.setKeys(old=>({...old,[p.id]:{apiKey:"",secretKey:""}}));
    s.patchProvider(p.id,{kind,baseUrl:protocols.some(item=>item.baseUrl===p.baseUrl)?preset.baseUrl:p.baseUrl,model:preset.model,appId:"",secretId:""});
  };
  const interfaceFields=<>
    {!custom&&<Field id={`${p.id}-name`} label={tr("显示名称")}><Input id={`${p.id}-name`} value={providerDisplayName(p)} onChange={e=>s.patchProvider(p.id,{name:e.target.value})} /></Field>}
    {!custom&&<Field id={`${p.id}-${http?"base":"url"}`} label={model||openai?"Base URL":http?tr("接口地址"):tr("WebSocket 地址")}><Input id={`${p.id}-${http?"base":"url"}`} className="font-mono text-xs" value={p.baseUrl} onChange={e=>s.patchProvider(p.id,{baseUrl:e.target.value})} /></Field>}
    {cloud&&<Field id={`${p.id}-language`} label={tr("识别语言")}><Input id={`${p.id}-language`} value={p.model} onChange={e=>s.patchProvider(p.id,{model:e.target.value})}/></Field>}
    {(tencent||p.kind==="dashscope"||p.kind==="volcengine") && <Field id={`${p.id}-engine`} label={p.kind==="volcengine"?tr("资源 ID"):tr("识别引擎")}><Input id={`${p.id}-engine`} value={p.model} onChange={e=>s.patchProvider(p.id,{model:e.target.value})} /></Field>}
  </>;
  const secretLabel=youdao?"应用密钥":cloud?"OCR API Key":p.kind==="ocr"?"OCR API Key":model?"模型 API Key":tencent?"腾讯云 Secret Key":["dashscope","volcengine","openai-asr"].includes(p.kind)?"语音 API Key":"RTasr API Key";
  return <div className="settings-provider-fields">
    {custom&&<>
      <Field id={`${p.id}-name`} label={tr("显示名称")}><Input id={`${p.id}-name`} value={providerDisplayName(p)} onChange={e=>s.patchProvider(p.id,{name:e.target.value})}/></Field>
      <Field id={`${p.id}-url`} label={tr("WebSocket 地址")}><Input id={`${p.id}-url`} className="font-mono text-xs" value={p.baseUrl} onChange={e=>s.patchProvider(p.id,{baseUrl:e.target.value})}/></Field>
    </>}
    {["xfyun","tencent","youdao-ocr"].includes(p.kind) && <Field id={`${p.id}-appid`} label={youdao?tr("应用 ID"):"App ID"}><Input id={`${p.id}-appid`} value={p.appId} onChange={e=>s.patchProvider(p.id,{appId:e.target.value.trim()})} /></Field>}
    {tencent && <Field id={`${p.id}-secretid`} label="Secret ID"><Input id={`${p.id}-secretid`} value={p.secretId} onChange={e=>s.patchProvider(p.id,{secretId:e.target.value.trim()})} /></Field>}
    <Field id={`${p.id}-key`} aside={help?<Button variant="link" size="xs" disabled={!!s.busy} onClick={()=>void s.action("provider-help",()=>invoke("open_provider_help",{help}))}>{tr("获取密钥")}</Button>:undefined} label={youdao?tr("应用密钥"):cloud||model?"API Key":tencent?"Secret Key":["dashscope","volcengine","openai-asr"].includes(p.kind)?"API Key":"RTasr API Key"}>
      <SecretInput id={`${p.id}-key`} label={tr(secretLabel)} value={s.keys[p.id]?.[tencent?"secretKey":"apiKey"]??""}
        placeholder={s.data.configured.includes(p.id) && !s.keys[p.id]?tr("读取中…"):"API Key"}
        onChange={value=>{s.setKeys(old=>({...old,[p.id]:{apiKey:old[p.id]?.apiKey??"",secretKey:old[p.id]?.secretKey??"",[tencent?"secretKey":"apiKey"]:value.trim()}}));s.clearTest(p.id);if(group==="model"&&value.trim())s.defaultFirstVision(p.id);}} />
    </Field>
    {openai&&<Field id={`${p.id}-model`} label={tr("模型")}><Input id={`${p.id}-model`} value={p.model} onChange={e=>s.patchProvider(p.id,{model:e.target.value})}/></Field>}
    {model&&<ModelPicker store={s} provider={p} cache={catalogCache??ownCache}/>}
    <div className="settings-provider-options">
    <details className="settings-advanced"><summary>{tr("接口设置")}</summary><div className="space-y-4 pt-4">{custom&&<><Field id={`${p.id}-protocol`} label={tr("实时协议")}><TooltipHint label={tr("更换协议请添加新接口")} enabled={s.data.settings.providers.some(item=>item.id===p.id)}><span><Select value={p.kind} onValueChange={switchProtocol}><SelectTrigger id={`${p.id}-protocol`} disabled={!!s.busy||s.data.settings.providers.some(item=>item.id===p.id)}><SelectValue/></SelectTrigger><SelectContent>{protocols.map(item=><SelectItem key={item.kind} value={item.kind}>{tr(item.name)}</SelectItem>)}</SelectContent></Select></span></TooltipHint></Field><p className="settings-footnote">{tr("地址可自定义，服务须兼容所选实时协议。")}</p></>}{interfaceFields}</div></details>
    {group==="model"&&s.draft&&<div className="settings-screenshot-toggle"><Label htmlFor={`${p.id}-screenshot`}>{tr("识图")}</Label><Switch id={`${p.id}-screenshot`} checked={s.draft.screenshotModel===p.id} disabled={!!s.busy} onCheckedChange={checked=>s.setVisionModel(checked?p.id:s.draft?.screenshotModel===p.id?"":s.draft?.screenshotModel??"")}/></div>}
    </div>
    {actions&&<ProviderActions store={s} provider={p} group={group} onRemove={onRemove}/>}
  </div>;
}

export function ProviderActions({store:s,provider:p,group,onRemove,onSave}:{store:Copilot;provider:Provider;group:ServiceGroup;onRemove?:()=>void;onSave?:()=>void}) {
  const locale=useLocale();
  const result=s.testResults[p.id]??"";
  const failed=!!result&&!result.startsWith("连接成功")&&!result.startsWith("正在检测");
  const reason=result.split(/[，。；：\n]/,1)[0];
  const summary=failed?(locale==="en"?"检测失败，查看详情":reason.length<=12?reason:"检测失败，查看详情"):result;
  return <div className="settings-provider-check">
    <Button variant="outline" size="sm" disabled={!!s.busy||(s.data.configured.includes(p.id)&&!s.keys[p.id])} onClick={()=>void s.testCurrent(p)}>{s.busy==="test"?<Spinner/>:<Zap/>}{tr("检测")}</Button>
    <Button className="settings-save-provider" size="sm" disabled={!!s.busy||!s.serviceDirty(group)} onClick={()=>onSave?onSave():void s.saveConfig(group)}>{s.busy==="settings"?<Spinner/>:<Check/>}{tr("保存")}</Button>
    {onRemove&&<TooltipHint label={tr("删除服务")}><Button variant="ghost" size="icon-sm" className="settings-remove-provider" aria-label={tr("删除服务")} disabled={!!s.busy} onClick={onRemove}><Trash2/></Button></TooltipHint>}
    <TooltipHint label={messageText(result)} enabled={failed}><p role="status" aria-label={result?messageText(result):undefined} tabIndex={failed?0:undefined} className={failed?"settings-test-inline text-destructive":"settings-test-inline text-muted-foreground"}>{messageText(summary)}</p></TooltipHint>
  </div>;
}
