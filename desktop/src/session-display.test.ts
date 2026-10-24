import { describe,it,expect } from "vitest";
import { sessionDateKey,sessionDayLabel,sessionDisplayTitle,groupSessions,duplicateSessionNames,sessionSearchTerms } from "./lib/session-display";
import type { Session } from "./types";
const at=(y:number,m:number,d:number,h=10)=>new Date(y,m-1,d,h).getTime();
const record=(id:string,title:string,createdAt:number):Session=>({id,title,createdAt,endedAt:createdAt+60000});
describe("session labels",()=>{
 it("groups by local calendar day and keeps dates distinct across years",()=>{
  const items=[record("a","one",at(2026,1,1,12)),record("b","two",at(2026,1,1,9)),record("c","three",at(2025,1,1))];
  const groups=groupSessions(items,at(2026,1,2));expect(groups).toHaveLength(2);expect(groups[0].items.map(s=>s.id)).toEqual(["a","b"]);expect(groups[0].label).toBe("昨天");expect(groups[1].label).toBe("2025年1月1日");
  expect(sessionDateKey(items[0].createdAt)).not.toBe(sessionDateKey(items[2].createdAt));
 });
 it("uses calendar yesterday at month and year boundaries",()=>{
  expect(sessionDayLabel(at(2025,12,31,23),at(2026,1,1))).toBe("昨天");expect(sessionDayLabel(at(2026,3,1),at(2026,3,1,23))).toBe("今天");expect(sessionDayLabel(at(2026,2,27),at(2026,3,1))).toBe("2月27日");
 });
 it("normalizes only generated titles without changing stored names",()=>{
  const generated=record("a","面试 · 10-22 10:00",at(2026,10,22));expect(sessionDisplayTitle(generated)).toBe("未命名面试");expect(generated.title).toBe("面试 · 10-22 10:00");
  const custom=record("b","后端面试 · 第一轮",at(2026,10,22));expect(sessionDisplayTitle(custom)).toBe(custom.title);
 });
 it("disambiguates repeated display names within a day rather than every record",()=>{
  const group=[record("a","same",1),record("b","same",2),record("c","unique",3),record("d","面试 · 10-22 10:00",4),record("e","面试 · 10-22 11:00",5)];
  expect([...duplicateSessionNames(group)]).toEqual(["same","未命名面试"]);expect(duplicateSessionNames([group[0]])).toEqual(new Set());
 });
});

it("searches the displayed generated name and Chinese or ISO date labels",()=>{
 const session=record("generated","面试 · 10-22 10:00",at(2026,10,22));const terms=sessionSearchTerms(session,at(2026,10,22,23));
 expect(terms).toContain("未命名面试");expect(terms).toContain("2026-10-22");expect(terms).toContain("10月22日");expect(terms).toContain("今天");
});
