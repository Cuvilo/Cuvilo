import {cachedLanguage} from "@/i18n";
import type {
  Answer,
  AudioSource,
  Settings,
  Snapshot,
  Transcript,
} from "../types";

// Browser previews are isolated fixtures. Native windows never load these records or keys.
const at = 1792288800000;
export const previewSources: AudioSource[] = [
  {
    id: "preview-meeting",
    name: "腾讯会议",
    kind: "process",
    pid: 1234,
    recommended: true,
  },
  {
    id: "preview-system",
    name: "系统声音 · 所有应用",
    kind: "system",
    pid: null,
    recommended: false,
  },
];
export const previewSecrets = {
  qwen:{apiKey:"demo-model-key-not-a-real-key",secretKey:""},
  dashscope:{apiKey:"demo-asr-key-not-a-real-key",secretKey:""},
  xfyun: { apiKey: "demo-asr-key-not-a-real-key", secretKey: "" },
  deepseek: { apiKey: "demo-model-key-not-a-real-key", secretKey: "" },
};
export const previewTranscripts: Transcript[] = [
  {
    id: "t1",
    sessionId: "demo-session",
    source: "meeting",
    segmentId: "s1",
    text: "请介绍一下缓存的实现原理，如何处理缓存穿透？",
    isFinal: true,
    at,
    speechEndAt: at,
  },
  {
    id: "t2",
    sessionId: "demo-session",
    source: "meeting",
    segmentId: "s2",
    text: "如果同一个热点 Key 同时失效，大量请求过来，你会怎么处理？",
    isFinal: true,
    at: at + 18000,
    speechEndAt: at + 18000,
  },
  {
    id: "t3",
    sessionId: "demo-session",
    source: "meeting",
    segmentId: "s3",
    text: "可以结合一个具体的场景说说",
    isFinal: false,
    at: at + 24000,
    speechEndAt: at + 24000,
  },
];
export const previewAnswers: Answer[] = [
  {
    id: "a1",
    sources:[{materialId:"preview-knowledge",title:"缓存设计笔记",kind:"knowledge",excerpt:"演示资料：布隆过滤器可用于判断元素是否可能存在；对不存在的记录可短暂缓存空值。"}],
    sessionId: "demo-session",
    questionId: "q1",
    revision: 1,
    question: "请介绍一下缓存的实现原理，如何处理缓存穿透？",
    text: "缓存通过优先读取快速存储来减少数据库访问。缓存穿透可以从三层处理：\n\n- **入口校验**：过滤无效参数，减少异常请求。\n- **缓存空值**：查询不到的数据也写入短期空结果。\n- **布隆过滤器**：在访问存储前过滤明显不存在的键。\n\n具体组合需要结合数据规模和一致性要求。",
    status: "complete",
    mode: "short",
    createdAt: at,
    speechEndAt: at,
    triggerAt: at + 700,
    requestAt: at + 710,
    firstTokenMs: 460,
    firstSentenceMs: 1380,
  },
  {
    id: "a2",
    sessionId: "demo-session",
    questionId: "q2",
    revision: 1,
    question: "热点 Key 同时失效，大量请求过来，怎么处理？",
    text: "核心是让同一时刻只有少量请求回源，其他请求等待或读取旧值。\n\n1. **互斥重建**：一个请求获取锁并更新缓存，其余请求短暂等待后重试。\n2. **逻辑过期**：保留旧值，由后台异步刷新，适合允许短暂陈旧的数据。\n3. **流量保护**：配合限流、超时和降级，避免数据库被瞬时流量压垮。\n\n锁需要设置过期时间，并通过唯一标识安全释放。",
    status: "complete",
    mode: "short",
    createdAt: at + 18000,
    speechEndAt: at + 18000,
    triggerAt: at + 18700,
    requestAt: at + 18710,
    firstTokenMs: 390,
    firstSentenceMs: 1240,
  },
];
export function createPreview(settings: Settings): Snapshot {
  let theme:Settings["theme"]="light";try{const cached=localStorage.getItem("cuvilo.theme");if(cached==="dark"||cached==="system")theme=cached;}catch{/* Preview keeps the default appearance if storage is unavailable. */}

  const live = new URLSearchParams(location.search).get("demo") === "live";
  const screenDemo=new URLSearchParams(location.search).get("screenDemo");
  const screenQuestion="给定整数数组 nums 和目标值 target，返回和为 target 的两个元素下标。每个元素只能使用一次。\n示例：nums = [2, 7, 11, 15]，target = 9，返回 [0, 1]。";
  const screenAnswer={...previewAnswers[0],id:"screen-demo-answer",questionId:"screen-demo-question",mode:"screen",question:screenQuestion,text:"使用哈希表记录已经遍历的数及其下标。每遍历一个数，检查它所需的另一个数是否已经出现。\n\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, value in enumerate(nums):\n        other = target - value\n        if other in seen:\n            return [seen[other], i]\n        seen[value] = i\n```\n\n时间复杂度 **O(n)**，空间复杂度 **O(n)**。"};
  return {
    settings: { ...structuredClone(settings), language: new URLSearchParams(location.search).get("lang")==="en"?"en":new URLSearchParams(location.search).get("lang")==="zh-CN"?"zh-CN":cachedLanguage(), theme, job: "Java 后端工程师", providers:settings.providers.map(p=>p.kind==="xfyun"?{...p,appId:"preview-app-id"}:p) },
    configured: new URLSearchParams(location.search).get("setupDemo")==="empty"?[]:new URLSearchParams(location.search).get("setupDemo")==="model"?[settings.activeModel]:[settings.asrProvider,settings.activeModel],
    warnings: [],
    notices: [],
    session: live
      ? {
          id: "demo-session",
          title: "后端工程师 · 技术面",
          createdAt: at,
          endedAt: null,
        }
      : null,
    transcripts: live ? previewTranscripts : [],
    answers: live ? screenDemo==="answered" ? [screenAnswer] : screenDemo ? [] : previewAnswers : [],
    screenCapture:live&&screenDemo?{version:1,jobId:"screen-demo-job",sessionId:"demo-session",stage:screenDemo==="answered"?"answered":screenDemo==="recognizing"?"recognizing":screenDemo==="error"?"error":"ready",text:screenDemo==="error"?"":screenQuestion,error:screenDemo==="error"?"演示：未识别出文字，请重新框选。":"",questionId:screenDemo==="answered"?screenAnswer.questionId:""}:undefined,
    materials: new URLSearchParams(location.search).get("demo") === "empty" ? [] : [
      {
        id: "m1",
        title: "个人简历",
        kind: "resume",
        text: "演示材料：后端开发方向，熟悉 Java、Spring Boot 和 MySQL。此内容仅用于界面预览。",
        enabled: true,
        updatedAt: at,
      },
      {
        id: "m2",
        title: "项目经历与技术总结",
        kind: "project",
        text: "演示材料：接口性能优化、缓存设计、数据库查询优化。请在实际使用时填写真实经历和指标。",
        enabled: true,
        updatedAt: at,
      },
      {
        id: "m3",
        title: "目标岗位描述",
        kind: "job",
        text: "演示材料：负责核心服务研发，关注服务稳定性、系统性能和可维护性。",
        enabled: false,
        updatedAt: at,
      },
      {id:"m4",title:"缓存设计笔记",kind:"knowledge",text:"演示资料：布隆过滤器、缓存穿透与热点失效处理。",enabled:true,updatedAt:at},
    ],
    sessions: new URLSearchParams(location.search).get("historyDemo")==="empty"?[]:new URLSearchParams(location.search).get("historyDemo")==="long"?Array.from({length:40},(_,i)=>({id:`history-fixture-${i}`,title:i===0?"后端工程师 · 技术面 · 长标题阅读与窗口缩放验证":"面试练习 · "+String(i+1).padStart(2,"0"),createdAt:at-i*86400000,endedAt:at-i*86400000+3600000})):[
      {
        id: "demo-session",
        title: "后端工程师 · 技术面",
        createdAt: at,
        endedAt: at + 3600000,
      },
      {
        id: "demo-session-2",
        title: "缓存与数据库 · 模拟练习",
        createdAt: at - 86400000,
        endedAt: at - 86000000,
      },
      {
        id: "demo-session-3",
        title: "项目经历 · 模拟练习",
        createdAt: at - 172800000,
        endedAt: at - 171600000,
      },
    ],
  };
}

export function previewHistoryDetail() {
  const long=new URLSearchParams(location.search).get("historyDemo")==="long";
  return {transcripts:previewTranscripts,answers:long?Array.from({length:20},(_,i)=>({...previewAnswers[i%previewAnswers.length],id:`history-answer-${i}`,questionId:`history-question-${i}`,question:`${i+1}. ${previewAnswers[i%previewAnswers.length].question}`,text:previewAnswers[i%previewAnswers.length].text+"\n\n"+previewAnswers[0].text})):previewAnswers};
}
