import {t as tr} from "@/i18n";
import type { Settings } from "@/types";
export const shortcutLabels: Record<string,string> = { answer: "立即回答", cancel: "停止生成", toggle: "显示或收起答案窗口", screen: "截图提问", manual: "手动提问" };
export function isMacPlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`);
}
const macKeySymbols: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  super: "⌘",
  meta: "⌘",
  cmd: "⌘",
  command: "⌘",
  enter: "↩",
  return: "↩",
  backspace: "⌫",
  delete: "⌦",
  esc: "⎋",
  escape: "⎋",
  tab: "⇥",
  up: "↑",
  arrowup: "↑",
  down: "↓",
  arrowdown: "↓",
  left: "←",
  arrowleft: "←",
  right: "→",
  arrowright: "→",
  backslash: "\\",
};
export function formatShortcut(value?: string, mac = isMacPlatform()) {
  if (!value) return "";
  if (!mac) return value;
  return value
    .split("+")
    .map(part => {
      const trimmed = part.trim();
      return macKeySymbols[trimmed.toLowerCase()] ?? trimmed;
    })
    .join("");
}
const normalizeShortcut = (value: string) =>
  value
    .toLowerCase()
    .split("+")
    .map(part =>
      part
        .trim()
        .replace(/^ctrl$/, "control")
        .replace(/^(cmd|command|meta)$/, "super")
        .replace(/^option$/, "alt")
        .replace(/^return$/, "enter"),
    )
    .sort()
    .join("+");
export function shortcutConflicts(shortcuts: Settings["shortcuts"]) {
  const errors: Record<string,string> = {};
  const entries = Object.entries({...shortcuts,manual:manualShortcut(shortcuts)});
  for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
    const [a,x]=entries[i], [b,y]=entries[j];
    if (x && y && normalizeShortcut(x) === normalizeShortcut(y)) errors[a]=errors[b]=tr("“{0}”与“{1}”使用了相同的快捷键",tr(shortcutLabels[a]),tr(shortcutLabels[b]));
  }
  return errors;
}

export function manualShortcut(shortcuts:Settings["shortcuts"]){
 if(shortcuts.manual!==undefined)return shortcuts.manual;
 return Object.values(shortcuts).some(value=>value&&normalizeShortcut(value)===normalizeShortcut("Ctrl+Shift+M"))?"":"Ctrl+Shift+M";
}
export function shortcutMatches(event:KeyboardEvent,value:string){
 if(!value||event.repeat||event.isComposing)return false;
 if(event.metaKey&&!isMacPlatform())return false;
 return normalizeShortcut(value)===normalizeShortcut([event.metaKey?"Super":"",event.ctrlKey?"Ctrl":"",event.altKey?"Alt":"",event.shiftKey?"Shift":"",event.code.replace(/^Key/,"").replace(/^Digit/,"")].filter(Boolean).join("+"));
}
