import {t as tr} from "@/i18n";
import type { Settings } from "@/types";
export const shortcutLabels: Record<string,string> = { answer: "立即回答", cancel: "停止生成", toggle: "显示或收起答案窗口", screen: "截图提问", manual: "手动提问" };
export function shortcutConflicts(shortcuts: Settings["shortcuts"]) {
  const normalize = (value: string) => value.toLowerCase().split("+").map(part => part.trim().replace(/^ctrl$/, "control").replace(/^return$/, "enter")).sort().join("+");
  const errors: Record<string,string> = {};
  const entries = Object.entries({...shortcuts,manual:manualShortcut(shortcuts)});
  for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
    const [a,x]=entries[i], [b,y]=entries[j];
    if (x && y && normalize(x) === normalize(y)) errors[a]=errors[b]=tr("“{0}”与“{1}”使用了相同的快捷键",tr(shortcutLabels[a]),tr(shortcutLabels[b]));
  }
  return errors;
}

export function manualShortcut(shortcuts:Settings["shortcuts"]){
 if(shortcuts.manual!==undefined)return shortcuts.manual;
 const normalize=(value:string)=>value.toLowerCase().split("+").map(p=>p.trim().replace(/^ctrl$/,"control")).sort().join("+");
 return Object.values(shortcuts).some(value=>value&&normalize(value)===normalize("Ctrl+Shift+M"))?"":"Ctrl+Shift+M";
}
export function shortcutMatches(event:KeyboardEvent,value:string){
 if(!value||event.repeat||event.isComposing||event.metaKey)return false;
 const normalize=(text:string)=>text.toLowerCase().split("+").map(p=>p.trim().replace(/^ctrl$/,"control")).sort().join("+");
 return normalize(value)===normalize([event.ctrlKey?"Ctrl":"",event.altKey?"Alt":"",event.shiftKey?"Shift":"",event.code.replace(/^Key/,"").replace(/^Digit/,"")].filter(Boolean).join("+"));
}
