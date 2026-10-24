import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Copilot } from "./use-copilot";
export type BackupInfo = { token: string; createdAt: number; materials: number; sessions: number; transcripts: number; answers: number };
export function useDataTools(s: Copilot) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[preview,setPreview]=useState<BackupInfo|null>(null);
  const working=useRef(false),alive=useRef(true),pending=useRef<string|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(pending.current)void invoke("discard_data_restore",{token:pending.current}).catch(()=>{});};},[]);
  const run=async(fn:()=>Promise<void>)=>{
    if(working.current || s.busy || s.data.session)return;
    if(!s.native){s.notify("请在桌面客户端中使用备份与恢复。");return;}
    working.current=true;setBusy(true);setError("");
    try{await fn();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
  };
  const create=()=>run(async()=>{
    const path=await save({defaultPath:`Cuvilo-${new Date().toISOString().slice(0,10)}.cuvilo-backup`,filters:[{name:"Cuvilo 数据备份",extensions:["cuvilo-backup"]}]});
    if(path){await invoke("create_data_backup",{path});if(alive.current)s.notify("备份已创建","success");}
  });
  const choose=()=>run(async()=>{
    const directory=await invoke<string>("app_data_path").catch(()=>undefined);
    const path=await open({defaultPath:typeof directory==="string"?directory:undefined,multiple:false,filters:[{name:"Cuvilo 数据备份",extensions:["cuvilo-backup"]}]});
    if(typeof path==="string"){
      const value=await invoke<BackupInfo>("preview_data_restore",{path});
      if(!value?.token || !Number.isFinite(value.createdAt))throw new Error("备份信息读取失败");
      if(alive.current){pending.current=value.token;setPreview(value);}else void invoke("discard_data_restore",{token:value.token}).catch(()=>{});
    }
  });
  const restore=()=>run(async()=>{
    if(!preview)return;
    await invoke("restore_data_backup",{token:preview.token});
    pending.current=null;
    try{await s.refresh();}catch{if(alive.current)setError("数据已恢复，列表刷新失败，请重新打开对应页面。");}
    if(alive.current){setPreview(null);s.notify("数据已恢复","success");}
  });
  return {busy,error,preview,create,choose,restore,close:()=>{if(!working.current){if(pending.current)void invoke("discard_data_restore",{token:pending.current}).catch(()=>{});pending.current=null;setPreview(null);setError("");}}};
}
export function useWindowMemory(native:boolean) {
  const [remember,setRemember]=useState(true),[loaded,setLoaded]=useState(!native),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const alive=useRef(true),working=useRef(false);
  useEffect(()=>{alive.current=true;if(native)void invoke<{remember:boolean;error?:string}>("get_answer_memory").then(value=>{if(!alive.current)return;if(typeof value?.remember!=="boolean")throw new Error("位置偏好读取失败");setRemember(value.remember);setError(value.error??"");setLoaded(true);}).catch(e=>{if(alive.current)setError(String(e));});return()=>{alive.current=false;};},[native]);
  const change=async(value:boolean)=>{
    if(working.current)return;
    if(!native){setRemember(value);return;}
    working.current=true;setBusy(true);setError("");
    try{await invoke("set_answer_memory",{remember:value});if(alive.current)setRemember(value);}catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}
  };
  return {remember,loaded,busy,error,change};
}
