// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TranscriptList } from "./components/answer-panel";
import { transcriptDisplayText } from "./state";
import type { Transcript } from "./types";
afterEach(cleanup);
it("preserves sentence punctuation, quotes, brackets, numbers and technical names",()=>{
 for(const text of [".NET 与 .5", "-5 和 −2", "“如何实现？”", "【转写缺口】", "（缓存）如何设计？", "缓存，穿透？"]) expect(transcriptDisplayText(text)).toBe(text);
 expect(transcriptDisplayText("\ufeff\u0085？缓存")).toBe("缓存");
 expect(transcriptDisplayText(" \t？ ，。！请介绍缓存？")).toBe("请介绍缓存？");
});
it("normalizes historical rows without modifying raw data",()=>{
 const values=["？请介绍缓存", "，如何处理穿透", "。 我补充一个条件", "？ 。！… "];
 const items=values.map((text,i):Transcript=>({id:String(i),sessionId:"s",segmentId:String(i),source:"meeting",text,isFinal:true,at:i,speechEndAt:i}));
 const {container}=render(<TranscriptList items={items}/>);
 expect(container.querySelectorAll(".transcript-row")).toHaveLength(3);
 expect(screen.getByText("请介绍缓存")).toBeTruthy();expect(screen.getByText("如何处理穿透")).toBeTruthy();
 expect(items.map(x=>x.text)).toEqual(values);
});
