import {useCallback,useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
export function useOcrStatus(native:boolean){
 const [status,setStatus]=useState<{available:boolean;languages:string[];message:string}|null>(null),[checking,setChecking]=useState(false);
 const [revision,setRevision]=useState(0);const retry=useCallback(()=>setRevision(n=>n+1),[]);
 useEffect(()=>{let alive=true;if(!native){setStatus({available:true,languages:["zh-CN"],message:"本地识别状态仅为界面演示"});return;}setChecking(true);void invoke<{available:boolean;languages:string[];message:string}>("screen_ocr_status").then(value=>{if(!value||!Array.isArray(value.languages))throw new Error("读取失败");if(alive)setStatus(value);}).catch(()=>{if(alive)setStatus({available:false,languages:[],message:"无法读取系统识别状态，请重试"});}).finally(()=>{if(alive)setChecking(false);});return()=>{alive=false;};},[native,revision]);
 return {status,checking,retry};
}
