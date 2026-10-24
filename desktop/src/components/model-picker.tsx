import {t as tr, useLocale, messageText} from "@/i18n";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Popover } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { Copilot } from "@/hooks/use-copilot";
import type { Provider } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, Spinner } from "./common";
export type CatalogModel = { id:string; name?:string|null; vision?:boolean|null };
export type CatalogCache = Map<string,{identity:string;models:CatalogModel[]}>;
export function ModelPicker({store:s,provider:p,cache}:{store:Copilot;provider:Provider;cache:RefObject<CatalogCache>}) {
  useLocale();
  const secret=s.keys[p.id];
  const identity=JSON.stringify([p.id,p.kind,p.baseUrl,secret?.apiKey??null,s.draft?.network]);
  const entry=cache.current.get(p.id);
  const [models,setModels]=useState<CatalogModel[]>(entry?.identity===identity?entry.models:[]);
  const [open,setOpen]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const [query,setQuery]=useState(""),[active,setActive]=useState(-1);
  const input=useRef<HTMLInputElement>(null),request=useRef(0),latest=useRef(identity),alive=useRef(true);
  latest.current=identity;
  const listId=useId(),errorId=useId();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;++request.current;};},[]);
  useEffect(()=>{++request.current;setLoading(false);setError("");setOpen(false);setQuery("");setActive(-1);const saved=cache.current.get(p.id);setModels(saved?.identity===identity?saved.models:[]);},[identity,cache,p.id]);
  const matches=models.filter(m=>`${m.id} ${m.name??""}`.toLowerCase().includes(query.toLowerCase()));
  const visible=matches.slice(0,200);
  useEffect(()=>{if(open&&active>=0)document.getElementById(`${listId}-${active}`)?.scrollIntoView({block:"nearest"});},[open,active,listId]);
  const choose=(id:string)=>{s.patchProvider(p.id,{model:id});setQuery("");input.current?.focus();setOpen(false);};
  const fetchModels=async()=>{
    if(!secret?.apiKey.trim()){setError("请先填写 API Key");return;}
    const version=++request.current;setLoading(true);setError("");
    try {
      const result=s.native?await invoke<CatalogModel[]>("list_provider_models",{provider:p,secret,network:s.draft!.network}):[{id:p.model||"demo-model",name:"预览模型"},{id:"demo-reasoner",name:"预览推理模型"}];
      if(!alive.current||version!==request.current||latest.current!==identity)return;
      const unique=[...new Map(result.filter(m=>m.id).map(m=>[m.id,m])).values()];
      cache.current.set(p.id,{identity,models:unique});setModels(unique);setQuery("");setActive(-1);
      if(unique.length)setOpen(true);else setError("没有可选模型，可直接输入名称");
    }catch(error) {if(alive.current&&version===request.current&&latest.current===identity)setError(typeof error==="string"?error:"获取模型失败，请检查密钥、地址或网络，也可直接输入");}
    finally {if(alive.current&&version===request.current)setLoading(false);}
  };
  return <Field id={`${p.id}-model`} label={tr("模型")}><div className="model-picker-field">
    <Popover.Root open={open} onOpenChange={setOpen}><div className="model-picker-row"><Popover.Anchor asChild><div className="model-picker-input">
      <Input ref={input} id={`${p.id}-model`} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open?listId:undefined} aria-activedescendant={open&&active>=0?`${listId}-${active}`:undefined} aria-describedby={error?errorId:undefined}
        value={p.model} placeholder={tr("选择或输入模型")} onFocus={()=>{if(models.length){setQuery("");setOpen(true);}}} onChange={e=>{s.patchProvider(p.id,{model:e.target.value});setQuery(e.target.value);setActive(-1);setOpen(!!models.length);}}
        onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();e.stopPropagation();setOpen(!!models.length);setActive(i=>visible.length?(e.key==="ArrowDown"?(i+1)%visible.length:(i<0?visible.length-1:(i-1+visible.length)%visible.length)):-1);}else if(e.key==="Enter"&&open&&active>=0&&visible[active]){e.preventDefault();choose(visible[active].id);}else if(e.key==="Escape"&&open){e.preventDefault();e.stopPropagation();setOpen(false);}else if(e.key==="Tab")setOpen(false);}}/>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={tr("展开模型列表")} disabled={!models.length} onClick={()=>{setQuery("");setActive(-1);const next=!open;input.current?.focus();setOpen(next);}}><ChevronDown/></Button>
    </div></Popover.Anchor><Button variant="outline" size="sm" disabled={loading||!!s.busy||(s.data.configured.includes(p.id)&&!secret)} onClick={()=>void fetchModels()}>{loading&&<Spinner/>}{tr("获取模型")}</Button></div>
    <Popover.Portal><Popover.Content role="presentation" className="model-picker-popup menu-surface" sideOffset={6} align="start" collisionPadding={12} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>e.preventDefault()} onInteractOutside={e=>{if(input.current?.contains(e.target as Node))e.preventDefault();}} onEscapeKeyDown={e=>{e.preventDefault();setOpen(false);input.current?.focus();}}>
      <div id={listId} role="listbox" aria-label={tr("可选模型")} className="model-picker-options">{visible.length?visible.map((model,i)=><div key={model.id} id={`${listId}-${i}`} role="option" aria-selected={p.model===model.id} data-active={active===i} onPointerMove={()=>setActive(i)} onPointerDown={e=>{e.preventDefault();choose(model.id);}}><span><strong>{model.id}</strong>{model.name&&model.name!==model.id&&<small>{model.name}</small>}</span>{p.model===model.id&&<Check aria-hidden="true"/>}</div>):<p className="model-picker-empty">{tr("无匹配项，可直接输入")}</p>}{matches.length>visible.length&&<p className="model-picker-empty">{tr("继续输入以筛选")}</p>}</div>
    </Popover.Content></Popover.Portal></Popover.Root>
    {error&&<p id={errorId} role="alert" className="settings-inline-error">{messageText(error)}</p>}
  </div></Field>;
}
