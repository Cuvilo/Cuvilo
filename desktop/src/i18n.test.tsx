// @vitest-environment jsdom
import {afterEach, expect, it, vi} from "vitest";
import {act, cleanup, render, renderHook, screen} from "@testing-library/react";
import {currentLocale, messageText, resolveLocale, setLanguage, t, useAppLanguage} from "./i18n";
import {providerDisplayName, createProvider} from "./lib/provider-presets";
import {AnswerText} from "./components/answer-panel";
import {previewAnswers} from "./lib/preview";

const api=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();});
it("resolves supported system languages and keeps an explicit choice independent",()=>{
 expect(resolveLocale("system","zh-TW")).toBe("zh-CN");
 expect(resolveLocale("system","en-GB")).toBe("en");
 expect(resolveLocale("system","fr-FR")).toBe("en");
 expect(resolveLocale("en","zh-CN")).toBe("en");
});
it("rerenders memoized answer chrome without translating model or user content",()=>{
 const original={...previewAnswers[0],text:"模型原文 must remain unchanged"};
 const {rerender}=render(<AnswerText answer={original} fontSize={14}/>);
 act(()=>setLanguage("en"));expect(screen.getByText(original.text)).toBeTruthy();
 rerender(<AnswerText answer={{...original,text:""}} fontSize={14}/>);
 expect(screen.getByText("Preparing an answer…")).toBeTruthy();
 act(()=>setLanguage("zh-CN"));expect(screen.getByText("正在整理回答…")).toBeTruthy();
});
it("localizes native messages with values while preserving raw details",()=>{
 setLanguage("en");
 expect(messageText("连接成功 · 931 ms")).toBe("Connected · 931 ms");
 expect(messageText("模型检测失败 HTTP 401：fixture-error")).toBe("Model test failed, HTTP 401: fixture-error");
 expect(messageText("fixture diagnostic: E_FAIL")).toBe("fixture diagnostic: E_FAIL");
 expect(messageText("constructor")).toBe("constructor");
 expect(t("{0} 条新问题",3)).toBe("3 new questions");
});
it("preserves custom provider names and stored channel numbering across languages",()=>{
 const provider={id:"qwen-fixture",name:"通义千问"};
 const custom={id:"compatible-fixture",name:"我的渠道"};
 setLanguage("en");expect(providerDisplayName(provider)).toBe("Qwen");expect(providerDisplayName(custom)).toBe("我的渠道");
 const first=createProvider("compatible");const second=createProvider("compatible",[first]);
 expect(second.name).toBe("兼容接口 2");
 expect(providerDisplayName(second)).toBe("Compatible API 2");
 setLanguage("zh-CN");expect(providerDisplayName(second)).toBe("兼容接口 2");
});
it("waits for saved settings and ignores a late system result after a manual choice",async()=>{
 let complete!:(value:string)=>void;api.invoke.mockImplementation(()=>new Promise<string>(resolve=>{complete=resolve;}));
 const {rerender}=renderHook(({preference,loaded}:{preference:"system"|"zh-CN";loaded:boolean})=>useAppLanguage(preference,loaded,true),{initialProps:{preference:"system",loaded:false}});
 expect(api.invoke).not.toHaveBeenCalled();
 rerender({preference:"system",loaded:true});expect(api.invoke).toHaveBeenCalledWith("system_language_name");
 rerender({preference:"zh-CN",loaded:true});await act(async()=>complete("en"));
 expect(currentLocale()).toBe("zh-CN");expect(localStorage.getItem("cuvilo.language")).toBe("zh-CN");
});
