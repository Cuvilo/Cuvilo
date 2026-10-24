import {currentLocale,t as tr} from "@/i18n";
import type { Session } from "@/types";
export function sessionDateKey(at:number) {
  const date=new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
export function sessionDayLabel(at:number,now=Date.now()) {
  const date=new Date(at),today=new Date(now),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
  if(sessionDateKey(at)===sessionDateKey(now))return tr("今天");
  if(sessionDateKey(at)===sessionDateKey(yesterday.getTime()))return tr("昨天");
  if(currentLocale()==="en")return new Intl.DateTimeFormat("en",{month:"short",day:"numeric",...(date.getFullYear()===today.getFullYear()?{}:{year:"numeric"})}).format(date);
  return `${date.getFullYear()===today.getFullYear()?"":`${date.getFullYear()}年`}${date.getMonth()+1}月${date.getDate()}日`;
}
export function sessionDisplayTitle(session:Session) {
  const title=session.title.trim();
  return !title||/^面试\s*·\s*\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(title)?tr("未命名面试"):session.title;
}
export function groupSessions(items:Session[],now=Date.now()) {
  const groups=new Map<string,{key:string;label:string;items:Session[]}>();
  for(const item of items) {
    const key=sessionDateKey(item.createdAt);
    if(!groups.has(key))groups.set(key,{key,label:sessionDayLabel(item.createdAt,now),items:[]});
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}
export function duplicateSessionNames(items:Session[]) {
  const names=new Map<string,number>();
  for(const item of items){const title=sessionDisplayTitle(item);names.set(title,(names.get(title)??0)+1);}
  return new Set([...names].filter(([,count])=>count>1).map(([name])=>name));
}

const fullDate=()=>new Intl.DateTimeFormat(currentLocale(),{year:"numeric",month:"long",day:"numeric"});
export function sessionSearchTerms(session:Session,now=Date.now()) {
  return `${sessionDisplayTitle(session)} ${sessionDateKey(session.createdAt)} ${fullDate().format(session.createdAt)} ${sessionDayLabel(session.createdAt,now)}`;
}
