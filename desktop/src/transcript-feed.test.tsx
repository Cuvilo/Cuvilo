// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TranscriptWorkspace } from "./components/transcript-workspace";
import type { Transcript } from "./types";
const fragments=(count:number,sessionId="s1")=>Array.from({length:count},(_,i):Transcript=>({id:`${sessionId}-${i+1}`,sessionId,segmentId:`seg-${i+1}`,source:"meeting",text:`转写片段 ${i+1}`,isFinal:true,at:1000+i,speechEndAt:1000+i}));
const rows=(element:HTMLElement)=>Array.from(element.querySelectorAll<HTMLElement>("[data-transcript-id]"));
const earlier=(element:HTMLElement)=>element.querySelector(".load-earlier")?32:0;
beforeEach(()=>{
  vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockImplementation(function(this:HTMLElement){return this.getAttribute("role")==="log"?200:0});
  vi.spyOn(HTMLElement.prototype,"scrollHeight","get").mockImplementation(function(this:HTMLElement){return this.getAttribute("role")==="log"?rows(this).length*40+earlier(this):0});
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){
    const log=this.closest<HTMLElement>('[role="log"]');
    if(this.dataset.transcriptId&&log)return new DOMRect(0,earlier(log)+rows(log).indexOf(this)*40-log.scrollTop,400,40);
    return new DOMRect(0,0,400,200);
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()});
describe("transcript workbench reading",()=>{
 it("initially renders the latest 80 fragments and follows new ones",()=>{
   const items=fragments(120);const view=render(<TranscriptWorkspace items={items} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});expect(rows(log)).toHaveLength(80);
   expect(screen.queryByText("转写片段 40")).toBeNull();expect(screen.getByText("转写片段 41")).toBeTruthy();
   view.rerender(<TranscriptWorkspace items={fragments(121)} sessionId="s1" active />);
   expect(rows(log)).toHaveLength(80);expect(screen.queryByText("转写片段 41")).toBeNull();
   expect(log.scrollTop).toBe(log.scrollHeight-log.clientHeight);
 });
 it("preserves the reading position and counts a revised fragment only once",()=>{
   const items=fragments(120);const view=render(<TranscriptWorkspace items={items} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});log.scrollTop=200;fireEvent.scroll(log);
   const next={...fragments(121)[120],text:"中间结果",isFinal:false};
   view.rerender(<TranscriptWorkspace items={[...items,next]} sessionId="s1" active />);
   expect(log.scrollTop).toBe(200);expect(screen.getByRole("button",{name:"1 条新转写 · 回到最新"})).toBeTruthy();
   view.rerender(<TranscriptWorkspace items={[...items,{...next,text:"最终修订",isFinal:true}]} sessionId="s1" active />);
   expect(log.scrollTop).toBe(200);expect(rows(log)).toHaveLength(81);expect(screen.queryByText("中间结果")).toBeNull();
   fireEvent.click(screen.getByRole("button",{name:"1 条新转写 · 回到最新"}));
   expect(rows(log)).toHaveLength(80);expect(log.scrollTop).toBe(log.scrollHeight-log.clientHeight);
 });
 it("prepends batches while keeping the visible row at the same position",()=>{
   render(<TranscriptWorkspace items={fragments(240)} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});log.scrollTop=300;fireEvent.scroll(log);
   const anchor=rows(log).find(row=>row.getBoundingClientRect().bottom>0)!;const top=anchor.getBoundingClientRect().top;
   fireEvent.click(screen.getByRole("button",{name:"加载更早的转写"}));
   expect(rows(log)).toHaveLength(160);expect(anchor.getBoundingClientRect().top).toBe(top);expect(log.scrollTop).toBe(3500);
   fireEvent.click(screen.getByRole("button",{name:"加载更早的转写"}));
   expect(rows(log)).toHaveLength(240);expect(anchor.getBoundingClientRect().top).toBe(top);expect(screen.queryByRole("button",{name:"加载更早的转写"})).toBeNull();
 });
 it("resets pagination, pending count and following for a new session",()=>{
   const view=render(<TranscriptWorkspace items={fragments(120)} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});log.scrollTop=0;fireEvent.scroll(log);
   view.rerender(<TranscriptWorkspace items={fragments(121)} sessionId="s1" active />);
   expect(screen.getByRole("button",{name:"1 条新转写 · 回到最新"})).toBeTruthy();
   view.rerender(<TranscriptWorkspace items={fragments(3,"s2")} sessionId="s2" active />);
   expect(rows(log)).toHaveLength(3);expect(log.scrollTop).toBe(0);expect(screen.queryByRole("button",{name:/回到最新/})).toBeNull();
   expect(screen.queryByRole("button",{name:"加载更早的转写"})).toBeNull();
 });
});

describe("transcript separator presentation", () => {
 it("hides punctuation-only fragments, displays revisions and leaves provider text untouched", () => {
   const item={...fragments(1)[0],text:" ？ ，。！… ",isFinal:false};
   const view=render(<TranscriptWorkspace items={[item]} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});
   expect(rows(log)).toHaveLength(0);
   expect(screen.getByText("实时转写")).toBeTruthy();
   view.rerender(<TranscriptWorkspace items={[{...item,text:"？请介绍缓存，如何避免穿透？"}]} sessionId="s1" active />);
   expect(rows(log)).toHaveLength(1);
   expect(screen.getByText("请介绍缓存，如何避免穿透？")).toBeTruthy();
   expect(item.text).toBe(" ？ ，。！… ");
 });
 it("only counts meaningful new fragments while paused and counts revisions once", () => {
   const items=fragments(120); const next={...fragments(121)[120],text:"？"};
   const view=render(<TranscriptWorkspace items={items} sessionId="s1" active />);
   const log=screen.getByRole("log",{name:"实时转写"});log.scrollTop=200;fireEvent.scroll(log);
   view.rerender(<TranscriptWorkspace items={[...items,next]} sessionId="s1" active />);
   expect(screen.queryByRole("button",{name:/1 条新转写/})).toBeNull();
   view.rerender(<TranscriptWorkspace items={[...items,{...next,text:"，如何处理缓存穿透"}]} sessionId="s1" active />);
   expect(screen.getByRole("button",{name:"1 条新转写 · 回到最新"})).toBeTruthy();
   view.rerender(<TranscriptWorkspace items={[...items,{...next,text:"？如何处理缓存穿透？"}]} sessionId="s1" active />);
   expect(screen.getByRole("button",{name:"1 条新转写 · 回到最新"})).toBeTruthy();expect(log.scrollTop).toBe(200);
 });
});
