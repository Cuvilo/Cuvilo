import {useState,type ReactNode} from "react";
import {CopyButton} from "./copy-button";
export function CodeBlock({text,language,children,onCopy}:{text:string;language?:string;children:ReactNode;onCopy?:(text:string)=>Promise<boolean>}){
 const [failed,setFailed]=useState(false);
 const copy=async(value:string)=>{setFailed(false);let ok=false;try{if(onCopy)ok=await onCopy(value);else{await navigator.clipboard.writeText(value);ok=true;}}catch{/* Keep the code and offer manual selection when clipboard access fails. */}setFailed(!ok);return ok;};
 return <div className="answer-code-block"><div className="answer-code-toolbar"><span>{language}</span><CopyButton store={{copy}} text={text} compact label="复制代码" copiedLabel="代码已复制"/></div><pre>{children}</pre>{failed&&<p role="alert" className="code-copy-error">复制失败，请选中代码复制</p>}</div>;
}
