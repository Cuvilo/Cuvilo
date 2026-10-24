// @vitest-environment jsdom
import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import {providerPresets,createProvider,existingPreset,providerDisplayName} from "./lib/provider-presets";
import {setupStatus} from "./lib/setup-status";
import {materialSection} from "./lib/material-kinds";
import {providerHelp} from "./lib/provider-help";
import {AnswerSources} from "./components/answer-sources";
import {previewAnswers} from "./lib/preview";
import type {Snapshot,Provider} from "./types";
afterEach(cleanup);
const provider=(kind:string,id:string):Provider=>({kind,id,name:id,model:"fixture",baseUrl:"https://fixture.invalid",appId:"fixture",secretId:"fixture"});
it("requires saved credentials and required selected-provider fields, without treating detection as readiness",()=>{
 const settings={activeModel:"model",asrProvider:"asr",providers:[provider("llm","model"),provider("xfyun","asr")]} as Snapshot["settings"];
 expect(setupStatus({settings,configured:[]})).toEqual({model:false,asr:false});expect(setupStatus({settings,configured:["model"]})).toEqual({model:true,asr:false});
 expect(setupStatus({settings,configured:["model","asr"]})).toEqual({model:true,asr:true});settings.providers[1].appId="";expect(setupStatus({settings,configured:["model","asr"]}).asr).toBe(false);settings.activeModel="removed";expect(setupStatus({settings,configured:["model","asr"]}).model).toBe(false);
});
it("groups legacy references as knowledge without mutating original kinds",()=>{expect(["resume","project","job","terms","knowledge"].map(materialSection)).toEqual(["personal","personal","personal","knowledge","knowledge"]);});
it("shows only provided evidence on demand and accepts historical answers without it",()=>{
 const view=render(<AnswerSources answer={{...previewAnswers[0],sources:undefined}}/>);expect(view.container.textContent).toBe("");
 view.rerender(<AnswerSources answer={{...previewAnswers[0],sources:[{materialId:"deleted-doc",title:"原文档名称",kind:"knowledge",excerpt:"保存时的命中段落"}]}}/>);
 expect(screen.getByText("来源")).toBeTruthy();expect(view.container.querySelector("details")?.open).toBe(false);expect(screen.getByText("保存时的命中段落")).toBeTruthy();expect(screen.getByText("原文档名称")).toBeTruthy();
});
it("offers only known provider help and never derives links from arbitrary endpoints",()=>{
 expect(providerHelp({...provider("llm","custom"),baseUrl:"https://api.deepseek.com"})).toBe("deepseek");expect(providerHelp(provider("llm","custom"))).toBeUndefined();expect(providerHelp({...provider("llm","custom"),baseUrl:"https://api.deepseek.com.evil.invalid"})).toBeUndefined();expect(providerHelp(provider("xfyun","new-provider"))).toBe("xfyun");
});

it("lists Aliyun first for both setup services and DeepSeek second for answers",()=>{
 expect(providerPresets.filter(p=>p.group==="model").slice(0,2).map(p=>p.id)).toEqual(["qwen","deepseek"]);
 expect(providerPresets.find(p=>p.group==="asr")?.id).toBe("dashscope");
});

it("keeps custom ASR channels independent of each other and of builtin vendors",()=>{
 const first=createProvider("openai-asr"),second=createProvider("openai-asr",[first]);expect(first.id).not.toBe(second.id);expect(second.name).toBe("OpenAI 2");
 expect(existingPreset([first,second],"openai-asr")).toBeUndefined();expect(existingPreset([first,second],"dashscope")).toBeUndefined();
 expect(providerHelp({...first,baseUrl:"wss://private.fixture.invalid"})).toBeUndefined();expect(providerHelp(first)).toBe("openai");
});

it("renames only generated legacy voice labels while preserving user names and channel identities",()=>{
 expect(providerDisplayName({id:"custom-asr-fixture",name:"自定义语音接口 2"})).toBe("兼容接口 2");expect(providerDisplayName({id:"custom-asr-fixture",name:"公司转写"})).toBe("公司转写");expect(providerDisplayName({id:"other",name:"自定义语音接口"})).toBe("自定义语音接口");
 const old={...provider("dashscope","custom-asr-legacy"),name:"自定义语音接口"};expect(existingPreset([old],"dashscope")).toBeUndefined();
});
