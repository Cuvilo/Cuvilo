import type {Snapshot} from "@/types";
export function setupStatus(data:Pick<Snapshot,"settings"|"configured">) {
 const {settings,configured}=data;
 const model=settings.providers.find(p=>p.id===settings.activeModel&&p.kind==="llm");
 const asr=settings.providers.find(p=>p.id===settings.asrProvider&&["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(p.kind));
 return {model:!!(model&&configured.includes(model.id)&&model.model.trim()&&model.baseUrl.trim()),asr:!!(asr&&configured.includes(asr.id)&&asr.baseUrl.trim()&&(asr.kind!=="openai-asr"||asr.model.trim())&&(["dashscope","volcengine","openai-asr"].includes(asr.kind)||asr.appId.trim())&&(asr.kind!=="tencent"||asr.secretId.trim()))};
}
