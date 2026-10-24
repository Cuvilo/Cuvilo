import {t as tr, useLocale} from "@/i18n";
import {forwardRef} from "react";
import type {Copilot} from "@/hooks/use-copilot";
import {Input} from "./ui/input";
export const AnswerWordsInput=forwardRef<HTMLInputElement,{store:Copilot;id:string;className?:string}>(({store:s,id,className},ref)=>{
 const words=(s.draft??s.data.settings).answerWords??200;
 const invalid=!Number.isInteger(words)||words<50||words>2000;
 return <Input ref={ref} id={id} className={className} type="number" inputMode="numeric" min={50} max={2000} step={50} value={words} aria-label={tr("生成字数")} aria-invalid={invalid} onChange={event=>{const value=Number(event.target.value);s.updatePreferences({answerWords:value});if(Number.isInteger(value)&&value>=50&&value<=2000)void s.preferences.retry();}} onBlur={()=>{if(invalid)s.updatePreferences({answerWords:s.data.settings.answerWords??200});}} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"," "].includes(event.key))event.stopPropagation();}}/>;
});
AnswerWordsInput.displayName="AnswerWordsInput";
