import {t as tr} from "@/i18n";
import type { Provider, Settings } from "@/types";
export type ServiceGroup="model"|"asr"|"ocr";
type Preset={id:string;name:string;group:ServiceGroup;kind:string;baseUrl:string;model:string};
export function providerDisplayName(p:Pick<Provider,"id"|"name">){
 const name=p.id.startsWith("custom-asr-")&&/^自定义语音接口(?: \d+)?$/.test(p.name)?p.name.replace("自定义语音接口","兼容接口"):p.name;
 const builtin=providerPresets.find(item=>(p.id===item.id||p.id.startsWith(item.id+"-"))&&(name===item.name||(name.startsWith(item.name+" ")&&/^\d+$/.test(name.slice(item.name.length+1)))));
 return builtin?tr(builtin.name)+name.slice(builtin.name.length):name;
}
export const youdaoFreeOcr:Provider={id:"youdao-free",name:"有道云端 OCR",kind:"youdao-free",baseUrl:"https://ocrtran.youdao.com/ocr/imgtranocr",model:"auto",appId:"",secretId:""};
export const cloudOcrKinds=["youdao-ocr","ocr-space"];
export const isCloudOcr=(p:Pick<Provider,"kind">)=>cloudOcrKinds.includes(p.kind);
export const isOcrProvider=(p:Pick<Provider,"kind">)=>p.kind==="ocr"||isCloudOcr(p);
export const providerPresets:Preset[]=[
 {id:"qwen",name:"通义千问",group:"model",kind:"llm",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",model:"qwen-plus"},
 {id:"deepseek",name:"DeepSeek",group:"model",kind:"llm",baseUrl:"https://api.deepseek.com",model:"deepseek-flash"},
 {id:"siliconflow",name:"硅基流动",group:"model",kind:"llm",baseUrl:"https://api.siliconflow.cn/v1",model:"deepseek-ai/DeepSeek-V4-Flash"},
 {id:"compatible",name:"兼容接口",group:"model",kind:"llm",baseUrl:"https://",model:""},
 {id:"dashscope",name:"阿里云 Paraformer",group:"asr",kind:"dashscope",baseUrl:"wss://dashscope.aliyuncs.com/api-ws/v1/inference",model:"paraformer-realtime-v2"},
 {id:"xfyun",name:"讯飞 RTasr",group:"asr",kind:"xfyun",baseUrl:"wss://rtasr.xfyun.cn/v1/ws",model:""},
 {id:"tencent",name:"腾讯云",group:"asr",kind:"tencent",baseUrl:"wss://asr.cloud.tencent.com/asr/v2",model:"16k_zh"},
 {id:"volcengine",name:"火山引擎 · 豆包语音",group:"asr",kind:"volcengine",baseUrl:"wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",model:"volc.seedasr.sauc.duration"},
 {id:"openai-asr",name:"OpenAI",group:"asr",kind:"openai-asr",baseUrl:"https://api.openai.com/v1",model:"gpt-transcribe"},
 {id:"youdao-ocr",name:"有道智云 OCR",group:"ocr",kind:"youdao-ocr",baseUrl:"https://openapi.youdao.com/ocrapi",model:"zh-CHS"},
 {id:"ocr-space",name:"OCR.space",group:"ocr",kind:"ocr-space",baseUrl:"https://api.ocr.space/parse/image",model:"chs"},
 {id:"qwen-ocr",name:"通义千问视觉",group:"ocr",kind:"ocr",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",model:"qwen3-vl-plus"},
 {id:"siliconflow-ocr",name:"硅基流动视觉",group:"ocr",kind:"ocr",baseUrl:"https://api.siliconflow.cn/v1",model:"Qwen/Qwen2.5-VL-72B-Instruct"},
 {id:"compatible-ocr",name:"兼容视觉接口",group:"ocr",kind:"ocr",baseUrl:"https://",model:""},
];
export function createProvider(id:string,providers:Provider[]=[]):Provider {
 const preset=providerPresets.find(p=>p.id===id);
 if(!preset)throw new Error("未知服务");
 let name=preset.name;for(let suffix=2;providers.some(p=>p.name===name);suffix++)name=`${preset.name} ${suffix}`;
 return {id:`${preset.id}-${crypto.randomUUID()}`,name,kind:preset.kind,baseUrl:preset.baseUrl,model:preset.model,appId:"",secretId:""};
}

function identity(provider:Pick<Provider,"kind"|"baseUrl">):string{
 if(["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(provider.kind))return provider.kind;
 try{const url=new URL(provider.baseUrl);let host=url.hostname.toLowerCase();if(host==="api.deepseek.com")host="deepseek";else if(host==="dashscope.aliyuncs.com"||host.endsWith(".maas.aliyuncs.com"))host="qwen";else if(host==="api.siliconflow.cn"||host==="api.siliconflow.com")host="siliconflow";else host=url.origin+url.pathname.replace(/\/$/,"");return `${provider.kind}:${host}`;}catch{return `${provider.kind}:unconfigured`;}
}
export function existingPreset(providers:Provider[],presetId:string){
 const preset=providerPresets.find(p=>p.id===presetId);if(!preset||(presetId.startsWith("compatible")||presetId==="openai-asr"))return undefined;
 return providers.find(p=>!p.id.startsWith("custom-asr-")&&p.kind===preset.kind&&(!presetId.startsWith("compatible")&&(p.id===presetId||p.id.startsWith(`${presetId}-`))||identity(p)===identity(preset)));
}
export function withoutProvider(settings:Settings,id:string):Settings{
 const providers=settings.providers.filter(p=>p.id!==id);
 return {...settings,providers,screenshotModel:settings.screenshotModel===id?"":settings.screenshotModel,activeModel:settings.activeModel===id?(providers.find(p=>p.kind==="llm")?.id??""):settings.activeModel,asrProvider:settings.asrProvider===id?(providers.find(p=>["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(p.kind))?.id??""):settings.asrProvider,ocrProvider:settings.ocrProvider===id?"local":settings.ocrProvider};
}
