import type {Provider} from "@/types";
export function providerHelp(provider:Provider):string|undefined {
 if(provider.kind==="openai-asr"){try{return new URL(provider.baseUrl).hostname==="api.openai.com"?"openai":undefined;}catch{return undefined;}}
 if(provider.kind==="youdao-ocr")return "youdao";
 if(provider.kind==="ocr-space")return "ocr-space";
 if(provider.id.startsWith("custom-asr-")) {
  try {const host=new URL(provider.baseUrl).hostname;
   if(provider.kind==="dashscope"&&["dashscope.aliyuncs.com","dashscope-intl.aliyuncs.com","dashscope-us.aliyuncs.com"].includes(host))return "qwen";
   if(provider.kind==="volcengine"&&host==="openspeech.bytedance.com")return "volcengine";
   if(provider.kind==="xfyun"&&host==="rtasr.xfyun.cn")return "xfyun";
   if(provider.kind==="tencent"&&host==="asr.cloud.tencent.com")return "tencent";
  }catch{/* Custom addresses do not imply a credential issuer. */}
  return undefined;
 }
 if(provider.kind==="volcengine")return "volcengine";
 if(provider.kind==="xfyun")return "xfyun";
 if(provider.kind==="tencent")return "tencent";
 if(provider.kind==="dashscope")return "qwen";
 try{const host=new URL(provider.baseUrl).hostname;if(host==="api.deepseek.com")return "deepseek";if(host==="dashscope.aliyuncs.com"||host.endsWith(".maas.aliyuncs.com"))return "qwen";if(host==="api.siliconflow.cn"||host==="api.siliconflow.com")return "siliconflow";}catch{/* Custom endpoints have no inferred credential website. */}
}
