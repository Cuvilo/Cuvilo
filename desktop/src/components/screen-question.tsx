import {useEffect,useId,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {Image as ImageIcon, PencilLine, ScanText, X} from "lucide-react";
import type {Copilot} from "@/hooks/use-copilot";
import type {Answer} from "@/types";
import {Button} from "./ui/button";
import {Textarea} from "./ui/textarea";
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from "./ui/dialog";
import {Spinner} from "./common";

export function ScreenQuestionStatus({store:s}:{store:Copilot}){
 const state=s.data.screenCapture;const [text,setText]=useState(""),[working,setWorking]=useState(false),[error,setError]=useState("");
 const workingRef=useRef(false),id=useId();
 useEffect(()=>{setText(state?.text??"");setError("");},[state?.jobId,state?.text]);
 if(!state||!s.data.session||!["capturing","recognizing","ready","error"].includes(state.stage))return null;
 const feedback=error||state.error;
 const emptyRecognition=/^(?:Error:\s*)?(?:演示[：:]\s*)?未识别出文字(?:[，,。.!！]|$)/u.test(feedback.trim());
 const pending=state.stage==="capturing"||state.stage==="recognizing";
 const run=async(command:string,args?:Record<string,unknown>)=>{if(workingRef.current)return false;if(!s.native){s.notify("当前为界面预览，请在桌面客户端操作。");return false;}workingRef.current=true;setWorking(true);setError("");try{if(command!=="cancel_screen_capture"&&!await s.preferences.retry())throw "设置未保存，请重试";await invoke(command,args);return true;}catch(e){setError(String(e));return false;}finally{workingRef.current=false;setWorking(false);}};
 return <section className="screen-question-status" aria-label="截图提问">
  <div className="flex items-center gap-2 text-xs text-muted-foreground">{pending?<Spinner/>:<ScanText className="size-3.5"/>}<span role="status">{state.stage==="capturing"?"框选题目 · Esc 取消":state.stage==="recognizing"?(state.fallback?"已改用 OCR，正在识别…":"正在识别题目…"):"屏幕提问"}</span><span className="flex-1"/><Button variant="ghost" size="icon-xs" aria-label="取消截图提问" disabled={working} onClick={()=>void run("cancel_screen_capture")}><X/></Button></div>
  {!pending&&<><label htmlFor={id} className="sr-only">识别出的题目</label><Textarea id={id} value={text} maxLength={12000} disabled={working} onChange={e=>setText(e.target.value)} placeholder="输入题目…" className="screen-question-input"/><div className="flex flex-wrap justify-end gap-2"><Button size="sm" disabled={working} onClick={()=>void run("cancel_screen_capture").then(ok=>{if(ok)void s.action("screen",()=>invoke("begin_screen_capture"));})}>重新框选</Button><Button variant="primary" size="sm" disabled={working||!text.trim()} onClick={()=>void run("submit_screen_question",{jobId:state.jobId,text})}>{working?<Spinner/>:null}回答此题</Button></div></>}
  {feedback&&!emptyRecognition&&<p role="alert" className="text-xs text-destructive break-words">{feedback}</p>}
 </section>;
}
export function ScreenQuestionActions({answer,store:s}:{answer:Answer;store:Copilot}){
 const [editing,setEditing]=useState(false),[text,setText]=useState(answer.question),[error,setError]=useState(""),[working,setWorking]=useState(false),[image,setImage]=useState<string|null>(null),[viewing,setViewing]=useState(false);
 const editTrigger=useRef<HTMLButtonElement>(null),imageTrigger=useRef<HTMLButtonElement>(null);
 const correctionRequest=useRef(0);
 const savedId=useRef(""),id=useId();
 useEffect(()=>{if(!editing)setText(answer.question);},[answer.question,editing]);
 useEffect(()=>{setImage(null);setViewing(false);savedId.current="";return()=>{savedId.current="";};},[s.data.screenCapture?.jobId,s.data.session?.id]);
 useEffect(()=>{++correctionRequest.current;setEditing(false);setError("");setWorking(false);return()=>{++correctionRequest.current;};},[s.data.session?.id]);
 if(!answer.mode.startsWith("screen"))return null;
 const current=s.data.screenCapture?.questionId===answer.questionId&&!!s.data.screenCapture?.jobId;
 const submit=async()=>{if(working)return;if(!s.native){s.notify("请在桌面客户端修正题目。");return;}const request=++correctionRequest.current;setWorking(true);setError("");try{if(!await s.preferences.retry())throw "设置未保存，请重试";await invoke("correct_screen_question",{questionId:answer.questionId,text});if(request===correctionRequest.current)setEditing(false);}catch(e){if(request===correctionRequest.current)setError(String(e));}finally{if(request===correctionRequest.current)setWorking(false);}};
 const showImage=async()=>{if(!current||!s.native)return;const job=s.data.screenCapture!.jobId;savedId.current=job;setError("");try{const value=await invoke<string>("screen_capture_image",{jobId:job});if(savedId.current===job&&value.startsWith("data:image/bmp;base64,")){setImage(value);setViewing(true);}}catch(e){if(savedId.current===job)s.notify(String(e),"error");}};
 return <><div className="screen-question-source"><span>屏幕提问</span><span className="flex-1"/>{current&&<Button variant="ghost" size="icon-xs" aria-label="查看原截图" ref={imageTrigger} onClick={()=>void showImage()}><ImageIcon/></Button>}<Button variant="ghost" size="icon-xs" aria-label="修正题目" ref={editTrigger} disabled={!s.data.session||answer.status==="generating"||working} onClick={()=>{setText(answer.question);setError("");setEditing(true);}}><PencilLine/></Button></div>
  <Dialog open={editing} onOpenChange={open=>{if(!working)setEditing(open);}}><DialogContent className="answer-manual-dialog" onCloseAutoFocus={e=>{e.preventDefault();editTrigger.current?.focus();}} onEscapeKeyDown={e=>{if(working)e.preventDefault();}} onInteractOutside={e=>{if(working)e.preventDefault();}}><DialogHeader><DialogTitle>修正题目</DialogTitle><DialogDescription className="sr-only">编辑识别的题目</DialogDescription></DialogHeader><label htmlFor={id} className="sr-only">题目内容</label><Textarea id={id} value={text} onChange={e=>setText(e.target.value)} disabled={working} maxLength={12000} className="screen-question-input"/>{error&&<p role="alert" className="text-xs text-destructive break-words">{error}</p>}<div className="flex justify-end gap-2"><Button disabled={working} onClick={()=>setEditing(false)}>取消</Button><Button variant="primary" disabled={working||!text.trim()} onClick={()=>void submit()}>{working?<Spinner/>:null}重新回答</Button></div></DialogContent></Dialog>
  <Dialog open={viewing} onOpenChange={open=>{setViewing(open);if(!open){setImage(null);savedId.current="";}}}><DialogContent className="screen-image-dialog" onCloseAutoFocus={e=>{e.preventDefault();imageTrigger.current?.focus();}}><DialogHeader><DialogTitle>原截图</DialogTitle><DialogDescription className="sr-only">查看截图原图</DialogDescription></DialogHeader>{image&&<div className="screen-image-scroll" tabIndex={0}><img src={image} alt="本次框选的题目原图"/></div>}</DialogContent></Dialog>
 </>;
}
