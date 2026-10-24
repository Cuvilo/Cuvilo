import { setupStatus } from "@/lib/setup-status";
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  Answer,
  AudioSource,
  Material,
  Notice,
  Provider,
  SecretUpdate,
  SessionEvent,
  Settings,
  Session,
  Snapshot,
  Transcript,
} from "../types";
import { mergeById, visibleAnswers } from "../state";
import type { MaterialSection } from "../lib/material-kinds";
import { materialDropError } from "../lib/material-import";
import { usePreferenceAutosave, type PreferencePatch } from "./use-preference-autosave";
import { shortcutConflicts } from "../lib/shortcut-validation";
import { withoutProvider, providerDisplayName, isOcrProvider, type ServiceGroup } from "../lib/provider-presets";
import { useMaterialImport } from "./use-material-import";
import { useNotification } from "./use-notification";
import {
  createPreview,
  previewSources,
  previewSecrets,
  previewTranscripts,
  previewAnswers,
  previewHistoryDetail,
} from "../lib/preview";
function settingsSignature(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value)])) : item;
  return JSON.stringify(normalize(value));
}
const native = isTauri();
const initial: Settings = {
  captureProtection: true,
  asrProvider: "dashscope",
  activeModel: "qwen",
  providers: [
    {id:"qwen",name:"通义千问",kind:"llm",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",model:"qwen-plus",appId:"",secretId:""},
    {id:"dashscope",name:"阿里云 Paraformer",kind:"dashscope",baseUrl:"wss://dashscope.aliyuncs.com/api-ws/v1/inference",model:"paraformer-realtime-v2",appId:"",secretId:""},
    {
      id: "xfyun",
      name: "讯飞 RTasr",
      kind: "xfyun",
      baseUrl: "wss://rtasr.xfyun.cn/v1/ws",
      model: "",
      appId: "",
      secretId: "",
    },
    {
      id: "tencent",
      name: "腾讯云实时语音识别",
      kind: "tencent",
      baseUrl: "wss://asr.cloud.tencent.com/asr/v2",
      model: "16k_zh",
      appId: "",
      secretId: "",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      kind: "llm",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      appId: "",
      secretId: "",
    },
  ],
  network: { mode: "system", url: "" },
  shortcuts: {
    answer: "Ctrl+Enter",
    cancel: "Ctrl+Shift+X",
    toggle: "Ctrl+Shift+H",
    screen: "Ctrl+Shift+S",
    manual: "Ctrl+Shift+M",
  },
  screenCapture: { confirmBeforeAnswer: false, shiftDoubleClick: false },
  job: "软件开发工程师",
  silenceMs: 700,
  fontSize: 14,
  answerOpacity: 60,
  answerWords: 200,
};

export function useCopilot() {
  const overlay = new URLSearchParams(location.search).get("window") === "answer";
  const [loaded, setLoaded] = useState(!native);
  const [workspace, setWorkspace] = useState<"prepare" | "review">("prepare");
  const [review, setReview] = useState<{ session: Session | null; transcripts: Transcript[]; answers: Answer[]; loading: boolean; error: string }>({ session: null, transcripts: [], answers: [], loading: false, error: "" });
  const reviewRequest = useRef(0);
  const reviewTarget = useRef<{ session: Session | null; persisted: boolean } | undefined>(undefined);
  const snapshotRequest = useRef(0);
  const snapshotUpdates=useRef<{sessionId:string|null;transcripts:Map<string,Transcript>;answers:Map<string,Answer>}|null>(null);
  const loadReview = useCallback(async (session: Session | null, persisted = false) => {
    const previous = reviewTarget.current;
    reviewTarget.current = { session, persisted: persisted || (!!session && previous?.session?.id === session.id && previous.persisted) };
    const request = ++reviewRequest.current;
    setReview({ session, transcripts: [], answers: [], loading: !!session, error: "" });
    if (!session) return;
    try {
      const detail = native ? await invoke<{ transcripts: Transcript[]; answers: Answer[] }>("session_detail", { id: session.id }) : { transcripts: previewTranscripts, answers: previewAnswers };
      if (!detail || !Array.isArray(detail.transcripts) || !Array.isArray(detail.answers)) throw new Error("复盘内容读取失败，请重试");
      if (request === reviewRequest.current) setReview({ session, ...detail, loading: false, error: "" });
    } catch (error) {
      if (request === reviewRequest.current) setReview({ session, transcripts: [], answers: [], loading: false, error: String(error) });
    }
  }, []);
  const [view, setView] = useState(
    new URLSearchParams(location.search).get("page") ?? "interview",
  );
  const [data, setData] = useState<Snapshot>(() =>
    native
      ? {
          notices: [],
          warnings: [],
          settings: initial,
          configured: [],
          session: null,
          transcripts: [],
          answers: [],
          materials: [],
          sessions: [],
        }
      : createPreview(initial),
  );
  const [materialSection, setMaterialSection] = useState<MaterialSection>("personal");
  const [homeService,setHomeService] = useState<ServiceGroup|null>(null);
  const [homeGuide,setHomeGuide] = useState<"auto"|"open"|"hidden">("auto");
  const [homeAudioPending, setHomeAudioPending] = useState(false);
  const [audioCheckedSource, setAudioCheckedSource] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const { toast, notify, dismissToast } = useNotification();
  const [busy, setBusy] = useState("");
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [sources, setSources] = useState<AudioSource[]>(
    native ? [] : previewSources,
  );
  const [sourceId, setSourceId] = useState(native ? "" : (previewSources.find(source => source.kind === "system")?.id ?? ""));
  useEffect(() => {
    if (!loaded) return;
    const ready = setupStatus(data);
    if (!ready.model || !ready.asr) setHomeAudioPending(true);
    else if (sourceId && audioCheckedSource === sourceId) setHomeAudioPending(false);
  }, [loaded, data.settings, data.configured, sourceId, audioCheckedSource]);
  const [microphone, setMicrophone] = useState(false);
  const [title, setTitle] = useState("");
  const [manual, setManual] = useState("");
  const [manualRequest,setManualRequest]=useState<{sessionId:string;version:number}|null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [top, setTop] = useState(true);
  const [opacityPreview,setOpacityPreview]=useState<number|null>(null);
  const opacityFrame=useRef<number|null>(null),opacityPending=useRef(60),opacityExpiry=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(opacityFrame.current!==null)cancelAnimationFrame(opacityFrame.current);if(opacityExpiry.current)clearTimeout(opacityExpiry.current);},[]);
  const [historyId, setHistoryId] = useState("");
  const historyRequest = useRef(0);
  const historyMemory = useRef<{query:string;listTop:number;collapsed:boolean;reading:Record<string,import("../types").ReviewReadingState>}>({query:"",listTop:0,collapsed:false,reading:{}});
  const [historyLoading,setHistoryLoading] = useState(false);
  const [historyError,setHistoryError] = useState("");
  const [historyData, setHistoryData] = useState<{
    transcripts: Transcript[];
    answers: Answer[];
  }>({ transcripts: [], answers: [] });
  const importing = useRef(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<
    Record<string, { apiKey: string; secretKey: string }>
  >(native ? {} : previewSecrets);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const keyReadVersions = useRef<Record<string,number>>({});
  const keyBaseline = useRef<Record<string,string>>(native ? {} : Object.fromEntries(Object.entries(previewSecrets).map(([id,value]) => [id,JSON.stringify(value)])));
  const testVersions = useRef<Record<string, number>>({});
  const firstVisionChoice = useRef(false);
  const runningRef = useRef<string | null>(null);
  const action = async (name: string, fn: () => Promise<unknown>) => {
    if (!native) {
      notify("当前是界面预览，请在桌面客户端中使用此功能。");
      return;
    }
    setBusy(name);
    try {
      await fn();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy("");
    }
  };
  const refresh = useCallback(async () => {
    if (!native) return;
    const request = ++snapshotRequest.current;
    const updates={sessionId:runningRef.current,transcripts:new Map<string,Transcript>(),answers:new Map<string,Answer>()};
    snapshotUpdates.current=updates;
    try{
      const snap = await invoke<Snapshot>("snapshot");
      if (request !== snapshotRequest.current) return;
      if(snap.session){
        for(const transcript of updates.transcripts.values())if(transcript.sessionId===snap.session.id)snap.transcripts=mergeById(snap.transcripts,transcript);
        for(const answer of updates.answers.values())if(answer.sessionId===snap.session.id)snap.answers=mergeById(snap.answers,answer);
      }
      runningRef.current = snap.session?.id ?? null;
      setData(old=>old.session?.id===snap.session?.id&&(old.screenCapture?.version??-1)>(snap.screenCapture?.version??-1)?{...snap,screenCapture:old.screenCapture}:snap);
      setNotices(snap.notices ?? []);
      setFontSize(snap.settings.fontSize);
      setLoaded(true);
    }finally{if(snapshotUpdates.current===updates)snapshotUpdates.current=null;}
  }, []);
  const loadSources = useCallback(async () => {
    if (!native) return;
    try {
      const list = await invoke<AudioSource[]>("audio_sources");
      setSources(list);
      setSourceId((old) =>
        list.some((s) => s.id === old)
          ? old
          : (list.find((s) => s.kind === "system")?.id ?? list.find((s) => s.recommended)?.id ?? ""),
      );
    } catch (error) {
      notify(String(error), "error");
    }
  }, [notify]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const channel = new Channel<SessionEvent>();
    channel.onmessage = (event) => {
      if (disposed) return;
      if(event.type==="themePreview"&&overlay&&event.theme){setData(old=>({...old,settings:{...old.settings,theme:event.theme}}));return;}
      if(event.type==="answerOpacityPreview"&&typeof event.opacity==="number"){
        const value=Math.max(20,Math.min(100,event.opacity));setOpacityPreview(value);
        if(opacityExpiry.current)clearTimeout(opacityExpiry.current);
        opacityExpiry.current=setTimeout(()=>setOpacityPreview(null),1800);return;
      }
      if (event.type === "dataRestored") {
        ++historyRequest.current;setHistoryId("");setHistoryData({transcripts:[],answers:[]});
        ++reviewRequest.current;reviewTarget.current=undefined;
        setReview({session:null,transcripts:[],answers:[],loading:false,error:""});
        void refresh();return;
      }
      if(event.type==="manualQuestionRequested"){
        if(overlay&&event.sessionId)setManualRequest(old=>({sessionId:event.sessionId!,version:(old?.version??0)+1}));
        return;
      }
      if (event.type === "workflowError") {
        notify(event.message ?? "窗口操作失败，请重试", "error");
        return;
      }
      if (event.type === "reviewRequested") {
        if (!overlay) {
          setView("interview");
          setWorkspace("review");
          void loadReview(event.session ?? null);
        }
        void refresh();
        return;
      }
      if (event.type === "captureProtectionRecovered") {
        setDraft(old => old && ({ ...old, captureProtection: !!event.enabled }));
        void refresh();
        return;
      }
      if (
        event.type === "settingsChanged" ||
        event.type === "captureProtectionChanged" ||
        event.type === "materialsChanged" ||
        event.type === "historyChanged"
      ) {
        void refresh();
        return;
      }
      if (event.type === "sessionStarted" && event.session) {
        setWorkspace("prepare");
        ++snapshotRequest.current;
        ++reviewRequest.current;
        reviewTarget.current = undefined;
        runningRef.current = event.session.id;
        setNotices([]);
        setLevels({});
        setData((d) => ({
          ...d,
          session: event.session!,
          screenCapture: undefined,
          transcripts: [],
          answers: [],
        }));
        setManual("");
        setSelected(null);
        setPinned(false);
        return;
      }
      if (event.type === "sessionStopped") {
        if (event.sessionId !== runningRef.current) return;
        runningRef.current = null;
        setNotices([]);
        setLevels({});
        setData((d) => ({ ...d, session: null, screenCapture: undefined }));
        void refresh();
        return;
      }
      // During the first snapshot runningRef is still unknown. Retain only
      // stream events here and match their session against the returned snapshot
      // before applying them; a final event may be the last one ever received.
      const pending=snapshotUpdates.current;
      if(pending&&event.sessionId&&(pending.sessionId===null||pending.sessionId===event.sessionId)){
        if(event.type==="transcript"&&event.transcript)pending.transcripts.set(event.transcript.id,event.transcript);
        if(event.type==="answer"&&event.answer)pending.answers.set(event.answer.id,event.answer);
      }
      if (
        event.sessionId &&
        event.sessionId !== "test" &&
        event.sessionId !== runningRef.current
      )
        return;
      if(event.type === "screenCapture" && event.screenCapture) {
        setData(d=>{const incoming=event.screenCapture!;return (d.screenCapture?.version??-1)>incoming.version?d:{...d,screenCapture:incoming};});return;
      }
      if (event.type === "status") {
        setNotices((old) =>
          [
            ...old.filter((n) => n.source !== event.source),
            {
              source: event.source ?? "",
              message: event.message ?? "",
              error: !!event.error,
              at: event.at ?? Date.now(),
            },
          ].slice(-8),
        );
        return;
      }
      if (event.type === "level") {
        setLevels((old) => ({
          ...old,
          [event.source ?? "meeting"]: event.level ?? 0,
        }));
        return;
      }
      if (event.sessionId !== runningRef.current) return;
      if (event.type === "transcript" && event.transcript){
        setData((d) => ({
          ...d,
          transcripts: mergeById(d.transcripts, event.transcript!),
        }));
      }
      if (event.type === "answer" && event.answer){
        setData((d) => ({
          ...d,
          answers: mergeById(d.answers, event.answer!),
        }));
      }
    };
    void invoke("report_ready").catch(() => {});
    void invoke("subscribe", { events: channel })
      .then(refresh)
      .catch((e) => notify(String(e), "error"));
    void loadSources();
    return () => {
      disposed = true;
    };
  }, [refresh, loadSources, notify, loadReview, overlay]);
  useEffect(() => {
    if (!loaded || overlay || data.session) return;
    const latest = data.sessions.find(session => session.endedAt !== null) ?? null;
    const target = reviewTarget.current;
    if (!target) void loadReview(latest, !!latest);
    else if (target.session) {
      if (data.sessions.some(session => session.id === target.session!.id)) target.persisted = true;
      else if (target.persisted) void loadReview(latest, !!latest);
    }
  }, [loaded, overlay, data.session, data.sessions, loadReview]);
  useEffect(() => () => { ++reviewRequest.current; ++snapshotRequest.current; }, []);
  useEffect(() => {
    if ((view === "settings" || homeService) && loaded && !draft)
      setDraft(structuredClone(data.settings));
  }, [view, homeService, draft, data.settings, loaded]);
  useEffect(() => {
    if (!native || (view !== "settings" && !homeService) || !loaded) return;
    let disposed = false;
    for (const id of data.configured) {
      const version = keyReadVersions.current[id] ?? 0;
      void invoke<{ apiKey: string; secretKey: string }>(
        "read_provider_secret",
        { providerId: id },
      )
        .then((secret) => {
          if (!disposed && version === (keyReadVersions.current[id] ?? 0)) {
            keyBaseline.current[id] = JSON.stringify(secret);
            setKeys((old) => ({ ...old, [id]: old[id] ?? secret }));
          }
        })
        .catch(() => {
          if (!disposed) notify("读取已保存密钥失败，请重试打开设置页。", "error");
        });
    }
    return () => {
      disposed = true;
    };
  }, [view, homeService, loaded, data.configured.join("|"), notify]);
  const answers = visibleAnswers(data.answers);
  const current =
    (pinned
      ? answers.find((a) => a.id === selected || a.questionId === selected)
      : null) ?? answers.at(-1);
  const currentIndex = current
    ? answers.findIndex((a) => a.id === current.id)
    : -1;
  const unseen = pinned ? answers.length - 1 - currentIndex : 0;
  const currentStatus = data.session
    ? (notices.find((n) => n.source === "meeting")?.message ??
      "正在连接语音服务")
    : "准备就绪";
  const begin = () =>
    action("start", async () => {
      if (!await preferences.retry()) throw "设置未保存，请重试";
      const source = sources.find((s) => s.id === sourceId);
      if (!source) throw "请选择一个可用音源";
      setNotices([]);
      setLevels({});
      await invoke("start_session", { options: { source, microphone, title } });
    });
  const request = (mode = "short", answer?: Answer) =>
    action("answer", async () => {
      if (!await preferences.retry()) throw "设置未保存，请重试";
      return invoke("request_answer", {
        text: answer?.question ?? (manual.trim() || null),
        questionId: answer?.questionId ?? null,
        mode,
      }).then(() => setManual(""));
    });
  const end = () => action("stop", () => invoke("stop_session"));
  const history = async (id: string) => {
    const request = ++historyRequest.current;
    setHistoryId(id);setHistoryError("");setHistoryLoading(true);
    setHistoryData({transcripts:[],answers:[]});
    try {
      const detail = native ? await invoke<{ transcripts: Transcript[]; answers: Answer[] }>("session_detail", { id }) : previewHistoryDetail();
      if(!detail||!Array.isArray(detail.answers)||!Array.isArray(detail.transcripts))throw new Error("记录读取失败，请重试");
      if(historyRequest.current===request)setHistoryData(detail);
    }catch(error){if(historyRequest.current===request)setHistoryError(String(error));}
    finally{if(historyRequest.current===request)setHistoryLoading(false);}
  };
  useEffect(() => {
    if (loaded && historyId && !data.sessions.some(session => session.id === historyId)) {
      historyRequest.current++;setHistoryLoading(false);setHistoryError("");
      setHistoryId("");
      setHistoryData({ transcripts: [], answers: [] });
    }
  }, [loaded, data.sessions, historyId]);
  const deleteHistory = async (selection: string | string[]) => {
    const ids = Array.isArray(selection) ? selection : [selection];
    if (!ids.length) return { ok: false, error: "请先选择记录。" };
    if (!native) return { ok: false, error: "请在桌面客户端中删除记录。" };
    setBusy("delete-history");
    let removed = false;
    try {
      if (Array.isArray(selection)) await invoke("delete_sessions", { ids });
      else await invoke("delete_session", { id: selection });
      removed = true;
      setData(old => ({ ...old, sessions: old.sessions.filter(session => !ids.includes(session.id)) }));
      if (ids.includes(historyId)) {
        historyRequest.current++;setHistoryLoading(false);setHistoryError("");
        setHistoryId("");
        setHistoryData({ transcripts: [], answers: [] });
      }
      await refresh();
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: removed, error: removed ? "" : String(error) };
    } finally {
      setBusy("");
    }
  };
  const exportHistory = (id: string) =>
    action("export", async () => {
      const path = await save({
        defaultPath: `面试记录-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (path) {
        await invoke("export_session", { id, path });
        notify("已导出 Markdown", "success");
      }
    });
  const serviceValues=(value:Settings)=>({providers:value.providers,activeModel:value.activeModel,screenshotModel:value.screenshotModel??"",asrProvider:value.asrProvider,ocrProvider:value.ocrProvider??"local"});
  const preferences=usePreferenceAutosave(native,patch=>{
    setData(old=>({...old,settings:{...old.settings,...patch}}));
    if(patch.fontSize!==undefined)setFontSize(patch.fontSize);
    if(patch.answerOpacity!==undefined)setOpacityPreview(old=>old===patch.answerOpacity?null:old);
  });
  useEffect(()=>{
    if(preferences.status!=="saving"&&preferences.status!=="error")setDraft(old=>old&&({...old,answerOpacity:data.settings.answerOpacity,answerWords:data.settings.answerWords}));
  },[data.settings.answerOpacity,data.settings.answerWords,preferences.status]);
  const updatePreferences=(patch:PreferencePatch)=>{
    if(patch.answerOpacity!==undefined){
      patch={...patch,answerOpacity:Math.max(20,Math.min(100,patch.answerOpacity))};
      setOpacityPreview(patch.answerOpacity!);opacityPending.current=patch.answerOpacity!;
      if(native&&opacityFrame.current===null)opacityFrame.current=requestAnimationFrame(()=>{opacityFrame.current=null;void invoke("preview_answer_opacity",{opacity:opacityPending.current}).catch(()=>{/* The persisted change still synchronizes the answer window. */});});
    }
    const baseline=draft??data.settings;patch=Object.fromEntries(Object.entries(patch).filter(([key,value])=>settingsSignature(value)!==settingsSignature(baseline[key as keyof Settings]))) as PreferencePatch;
    if(!Object.keys(patch).length)return;
    setDraft(old=>({...old??data.settings,...patch}));
    if(patch.theme!==undefined)setData(old=>({...old,settings:{...old.settings,theme:patch.theme!}}));
    const valid=!(patch.answerWords!==undefined&&(!Number.isInteger(patch.answerWords)||patch.answerWords<50||patch.answerWords>2000))
      &&!(patch.fontSize!==undefined&&(!Number.isInteger(patch.fontSize)||patch.fontSize<14||patch.fontSize>30))
      &&!(patch.silenceMs!==undefined&&(!Number.isInteger(patch.silenceMs)||patch.silenceMs<300||patch.silenceMs>2000))
      &&!(patch.shortcuts&&Object.keys(shortcutConflicts(patch.shortcuts)).length)
      &&!(patch.network?.mode==="manual"&&!/^https?:\/\/[^/]+/.test(patch.network.url));
    if(valid)preferences.enqueue(patch);else preferences.cancel(Object.keys(patch));
  };
  const settingsDirty=!!draft&&(settingsSignature(serviceValues(draft))!==settingsSignature(serviceValues(data.settings))||Object.entries(keys).some(([id,value])=>draft.providers.some(p=>p.id===id)&&(value.apiKey.trim()||value.secretKey.trim())&&JSON.stringify(value)!==keyBaseline.current[id]));
  const groupProviders=(value:Settings,group:ServiceGroup)=>value.providers.filter(p=>group==="model"?p.kind==="llm":group==="ocr"?isOcrProvider(p):["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(p.kind));
  const selectedProvider=(value:Settings,group:ServiceGroup)=>group==="model"?value.activeModel:group==="asr"?value.asrProvider:value.ocrProvider??"local";
  const serviceDirty=(group:ServiceGroup)=>{
    if(!draft)return false;const id=selectedProvider(draft,group),provider=draft.providers.find(p=>p.id===id),saved=data.settings.providers.find(p=>p.id===id),key=keys[id];
    return (group==="model"&&(draft.screenshotModel??"")!==(data.settings.screenshotModel??""))||id!==selectedProvider(data.settings,group)||settingsSignature(provider)!==settingsSignature(saved)||!!(key&&(key.apiKey.trim()||key.secretKey.trim())&&JSON.stringify(key)!==keyBaseline.current[id]);
  };
  const saveConfig=async(group:ServiceGroup="model")=>{let saved=false;await action("settings",async()=>{
    if(!loaded||!draft)throw "正在读取配置";
    const selected=selectedProvider(draft,group),rawCurrent=draft.providers.find(p=>p.id===selected),current=rawCurrent?{...rawCurrent,name:providerDisplayName(rawCurrent)}:undefined;
    const providers=groupProviders(data.settings,group).map(p=>p.id===selected&&current?current:p);
    if(current&&!providers.some(p=>p.id===current.id))providers.push(current);
    const updates:SecretUpdate[]=Object.entries(keys).filter(([id,value])=>id===selected&&(value.apiKey.trim()||value.secretKey.trim())).map(([id,secret])=>({id,secret}));
    await invoke("save_services",{services:{group,providers,selected,...(group==="model"?{screenshotModel:draft.screenshotModel??""}:{})},updates});
    for(const update of updates){keyReadVersions.current[update.id]=(keyReadVersions.current[update.id]??0)+1;keyBaseline.current[update.id]=JSON.stringify(update.secret);}
    await refresh();saved=true;notify("设置已保存","success");
  });return saved;};
  const removeProvider=async(id:string)=>{
    setBusy("remove-provider");
    try{
      if(native&&data.settings.providers.some(p=>p.id===id))await invoke("remove_provider",{id});
      setDraft(old=>old?withoutProvider(old,id):old);
      setKeys(old=>{const next={...old};delete next[id];return next;});
      keyReadVersions.current[id]=(keyReadVersions.current[id]??0)+1;delete keyBaseline.current[id];
      testVersions.current[id]=(testVersions.current[id]??0)+1;
      setData(old=>({...old,settings:withoutProvider(old.settings,id),configured:old.configured.filter(value=>value!==id)}));
      if(native)await refresh().catch(()=>notify("服务已删除，刷新失败","error"));
      return {ok:true,error:""};
    }catch(error){return {ok:false,error:String(error)};}finally{setBusy("");}
  };
  const clearTest = (id: string) => {
    testVersions.current[id] = (testVersions.current[id] ?? 0) + 1;
    setTestResults((old) => ({ ...old, [id]: "" }));
    dismissToast();
  };
  const testCurrent = (provider: Provider) =>
    action("test", async () => {
      if (!draft || !loaded) throw "正在读取配置，请稍候";
      const version = testVersions.current[provider.id] ?? 0;
      setTestResults((old) => ({ ...old, [provider.id]: "正在检测当前输入…" }));
      try {
        const result = await invoke<string>("test_provider", {
          providerId: provider.id,
          provider,
          secret: keys[provider.id] ?? null,
          network: draft.network,
        });
        if ((testVersions.current[provider.id] ?? 0) !== version) return;
        setTestResults((old) => ({
          ...old,
          [provider.id]: result,
        }));
      } catch (error) {
        if ((testVersions.current[provider.id] ?? 0) !== version) return;
        setTestResults((old) => ({ ...old, [provider.id]: String(error) }));
      }
    });
  const setVisionModel=(id:string)=>{
    firstVisionChoice.current=true;
    setDraft(old=>old?{...old,screenshotModel:id}:old);
  };
  const defaultFirstVision=(id:string)=>{
    if(firstVisionChoice.current||!draft||draft.screenshotModel||data.settings.providers.some(p=>p.kind==="llm"&&data.configured.includes(p.id))||!draft.providers.some(p=>p.id===id&&p.kind==="llm"))return;
    firstVisionChoice.current=true;
    setDraft(old=>old?{...old,screenshotModel:id}:old);
  };
  const patchProvider = (id: string, patch: Partial<Provider>) => {
    clearTest(id);
    setDraft((d) =>
      d
        ? {
            ...d,
            providers: d.providers.map((p) =>
              p.id === id ? { ...p, ...patch } : p,
            ),
          }
        : d,
    );
  };
  const materialImport = useMaterialImport({
    read: path => invoke<string>("import_document", { path }),
    save: material => invoke("save_material", { material }),
  });
  const saveImports = async () => {
    const result = await materialImport.save();
    if (!result) return;
    let refreshed = true;
    if (result.saved.length) {
      setData(old => ({ ...old, materials: [...result.saved, ...old.materials.filter(m => !result.saved.some(item => item.id === m.id))] }));
      try { await refresh(); } catch { refreshed = false; notify("材料已保存，列表刷新失败，请稍后重新查看。", "error"); }
    }
    if (result.complete && materialImport.isCurrent(result.token)) { materialImport.close(); if (refreshed) notify("材料已保存", "success"); }
  };
  const readMaterialFile = async (file: string, kind: string) => {
    const text = await invoke<string>("import_document", { path: file });
    setEditing({
      id: crypto.randomUUID(),
      title: file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "新材料",
      kind, text, enabled: true, updatedAt: Date.now(),
    });
  };
  const importMaterial = async (getFiles: () => Promise<string[]>, kind: string) => {
    if (importing.current || busy || editing || materialImport.isOpen()) return;
    importing.current = true;
    try {
      await action("import", async () => {
        const paths = await getFiles();
        if (!paths.length) return;
        if (paths.length === 1) await readMaterialFile(paths[0],kind);
        else materialImport.start(paths,kind);
      });
    } finally { importing.current = false; }
  };
  const importDoc = (kind="resume") => importMaterial(async () => {
    const file = await open({ multiple: true, filters: [{ name: "个人材料", extensions: ["pdf", "docx", "txt", "md"] }] });
    return typeof file === "string" ? [file] : file ?? [];
  },kind);
  const importDropped = (paths: string[],kind="resume") => {
    const error = materialDropError(paths);
    if (error) { notify(error, "error"); return Promise.resolve(); }
    return importMaterial(async () => paths,kind);
  };
  const saveMaterial = () =>
    action("material", async () => {
      if (!editing) return;
      await invoke("save_material", { material: editing });
      setEditing(null);
      await refresh();
      notify("材料已保存", "success");
    });
  const copy = async (text: string, quiet=false) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      if(!quiet)notify("复制失败，请手动选择文字复制", "error");
      return false;
    }
  };

  const showAnswer = () => {
    if (native) return action("window", () => invoke("show_answer"));
    window.open("?window=answer&demo=live", "_blank", "width=460,height=430");
  };
  const newMaterial = (kind="project") => {
    if (importing.current || busy || editing || materialImport.isOpen()) return;
    setEditing({
      id: crypto.randomUUID(),
      title: "",
      kind,
      text: "",
      enabled: true,
      updatedAt: Date.now(),
    });
  };
  const deleteMaterial = async (selection: Material | Material[]) => {
    if (!native) return { ok: false, error: "请在桌面客户端中删除材料。" };
    setBusy("delete-materials");
    let removed = false;
    try {
      const ids = Array.isArray(selection) ? selection.map(item => item.id) : [selection.id];
      if (!ids.length) return { ok: false, error: "请先选择材料。" };
      if (Array.isArray(selection)) await invoke("delete_materials", { ids });
      else await invoke("delete_material", { id: selection.id });
      removed = true;
      setData(old => ({ ...old, materials: old.materials.filter(item => !ids.includes(item.id)) }));
      await refresh();
      return { ok: true, error: "" };
    } catch (error) { return { ok: removed, error: removed ? "" : String(error) }; }
    finally { setBusy(""); }
  };
  const toggleMaterial = (material: Material) =>
    action("material", async () => {
      await invoke("save_material", {
        material: { ...material, enabled: !material.enabled },
      });
      await refresh();
    });
  return {
    native,
    answerOpacity: Math.max(20,Math.min(100,opacityPreview??data.settings.answerOpacity??60)),
    loaded,
    view,
    setView,
    homeService, setHomeService, homeGuide, setHomeGuide, homeAudioPending, audioCheckedSource, setAudioCheckedSource, materialSection, setMaterialSection,
    workspace,
    setWorkspace,
    data,
    review,
    loadReview,
    notices,
    toast,
    dismissToast,
    busy,
    levels,
    sources,
    sourceId,
    setSourceId,
    microphone,
    setMicrophone,
    title,
    setTitle,
    manual,
    manualRequest,
    setManual,
    selected,
    setSelected,
    pinned,
    setPinned,
    fontSize,
    setFontSize,
    top,
    setTop,
    historyId,
    historyData,
    historyLoading,
    historyError,
    historyMemory,
    editing,
    setEditing,
    draft,
    setDraft,
    keys,
    setKeys,
    testResults,
    notify,
    action,
    refresh,
    loadSources,
    answers,
    current,
    currentIndex,
    unseen,
    currentStatus,
    begin,
    request,
    end,
    history,
    exportHistory,
    deleteHistory,
    settingsDirty,
    serviceDirty,
    saveConfig,
    updatePreferences,
    preferences,
    removeProvider,
    clearTest,
    testCurrent,
    patchProvider,
    setVisionModel,
    defaultFirstVision,
    materialImport,
    saveImports,
    importDoc,
    importDropped,
    saveMaterial,
    copy,
    showAnswer,
    newMaterial,
    deleteMaterial,
    toggleMaterial,
  };
}
export type Copilot = ReturnType<typeof useCopilot>;
