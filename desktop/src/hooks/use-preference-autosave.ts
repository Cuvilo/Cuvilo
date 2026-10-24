import {useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {Settings} from "@/types";
export type PreferencePatch=Partial<Pick<Settings,"language"|"theme"|"closeAction"|"job"|"silenceMs"|"fontSize"|"answerOpacity"|"answerWords"|"captureProtection"|"network"|"shortcuts"|"screenCapture">>;
export function usePreferenceAutosave(native:boolean,onSaved:(patch:PreferencePatch)=>void){
 const callback=useRef(onSaved);callback.current=onSaved;
 const pending=useRef<PreferencePatch>({}),timer=useRef<ReturnType<typeof setTimeout>|null>(null),inFlight=useRef<Promise<boolean>|null>(null),alive=useRef(true);
 const [status,setStatus]=useState<"idle"|"saving"|"saved"|"error">("idle"),[error,setError]=useState("");
 const flush=useCallback(()=>{
  if(inFlight.current)return inFlight.current;
  if(timer.current)clearTimeout(timer.current);timer.current=null;
  const work=async()=>{
   while(alive.current&&Object.keys(pending.current).length){
    const patch=pending.current;pending.current={};setStatus("saving");setError("");
    try{if(native)await invoke("save_preferences",{patch});if(!alive.current)return false;callback.current(patch);setStatus(Object.keys(pending.current).length?"saving":"saved");}
    catch(e){if(alive.current){pending.current={...patch,...pending.current};setError(String(e));setStatus("error");}return false;}
   }
   return alive.current;
  };
  const promise=work();inFlight.current=promise;void promise.finally(()=>{if(inFlight.current===promise)inFlight.current=null;});return promise;
 },[native]);
 const cancel=useCallback((keys:string[])=>{for(const key of keys)delete (pending.current as Record<string,unknown>)[key];if(timer.current)clearTimeout(timer.current);timer.current=null;if(Object.keys(pending.current).length)timer.current=setTimeout(()=>{timer.current=null;void flush();},350);else if(!inFlight.current)setStatus("idle");},[flush]);
 const enqueue=useCallback((patch:PreferencePatch)=>{pending.current={...pending.current,...patch};setStatus("saving");setError("");if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{timer.current=null;void flush();},350);},[flush]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(timer.current)clearTimeout(timer.current);};},[]);
 return {enqueue,cancel,status,error,retry:flush};
}
