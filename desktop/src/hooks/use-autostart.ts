import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
export function useAutostart(native:boolean){
 const[enabled,setEnabled]=useState(false),[loaded,setLoaded]=useState(!native),[busy,setBusy]=useState(false),[error,setError]=useState("");const alive=useRef(true),working=useRef(false),revision=useRef(0);
 const load=async()=>{const id=++revision.current;setError("");try{const value=native?await invoke<boolean>("get_autostart"):false;if(!alive.current||revision.current!==id)return;if(typeof value!=="boolean")throw new Error("开机启动读取失败");setEnabled(value);setLoaded(true);}catch(e){if(alive.current&&revision.current===id)setError(String(e));}};
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;revision.current++;};},[native]);
 const change=async(value:boolean)=>{if(working.current||!loaded)return;working.current=true;revision.current++;setBusy(true);setError("");try{const actual=native?await invoke<boolean>("set_autostart",{enabled:value}):value;if(actual!==value)throw new Error("开机启动核验失败");if(alive.current)setEnabled(actual);}catch(e){if(alive.current)setError(String(e));}finally{working.current=false;if(alive.current)setBusy(false);}};
 return{enabled,loaded,busy,error,change,retry:load};
}
