// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { SessionEvent, Settings, Snapshot } from "./types";
import { previewAnswers, previewTranscripts } from "./lib/preview";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  onFocusChanged: vi.fn(),
  dropHandler: null as ((event: {payload: any}) => void) | null,
  onDragDropEvent: vi.fn(),
  unlistenDrop: vi.fn(),
  unlistenFocus: vi.fn(),
  focusHandler: null as ((event: { payload: boolean }) => void) | null,
  channel: null as { onmessage: (event: SessionEvent) => void } | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: api.invoke,
  isTauri: () => true,
  Channel: class {
    onmessage: (event: SessionEvent) => void = () => {};
    constructor() {
      api.channel = this;
    }
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: vi.fn(), setAlwaysOnTop: api.setAlwaysOnTop, onFocusChanged: api.onFocusChanged }),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: api.onDragDropEvent }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
let settings: Settings;
let secrets: Record<string, { apiKey: string; secretKey: string }>;
let initialSnapshot: Promise<Snapshot> | null;
let delayedKey: Promise<{ apiKey: string; secretKey: string }> | null;
let delayedCheck: Promise<string> | null;
function snapshot(): Snapshot {
  return {
    settings: structuredClone(settings),
    configured: Object.keys(secrets),
    notices: [],
    warnings: [],
    session: null,
    transcripts: [],
    answers: [],
    materials: [],
    sessions: [],
  };
}
beforeEach(() => {
  vi.mocked(openDialog).mockReset();vi.mocked(saveDialog).mockReset();
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  })));
  localStorage.clear();
  // jsdom has no layout observer; these tests exercise events and focus, not geometry.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.history.replaceState({}, "", "/");
  api.channel = null;
  api.dropHandler = null;
  api.unlistenDrop.mockReset();
  api.onDragDropEvent.mockReset().mockImplementation(async handler => { api.dropHandler = handler; return api.unlistenDrop; });
  settings = {
    captureProtection: true,
    asrProvider: "xfyun",
    activeModel: "deepseek",
    providers: [
      {
        id: "xfyun",
        name: "讯飞 RTasr",
        kind: "xfyun",
        appId: "saved-fixture-app-id",
        baseUrl: "wss://fixture.invalid/ws",
        model: "",
        secretId: "",
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        kind: "llm",
        appId: "",
        baseUrl: "https://saved.fixture.invalid/v1",
        model: "saved-fixture-model",
        secretId: "",
      },
    ],
    network: { mode: "direct", url: "" },
    shortcuts: {
      answer: "Ctrl+Alt+Enter",
      cancel: "Ctrl+Alt+Backspace",
      toggle: "Ctrl+Alt+Shift+Space",
    },
    job: "fixture job",
    fontSize: 14,
    silenceMs: 700,
  };
  secrets = {
    xfyun: { apiKey: "saved-fixture-asr-key", secretKey: "" },
    deepseek: { apiKey: "saved-fixture-model-key", secretKey: "" },
  };
  initialSnapshot = null;
  delayedKey = null;
  delayedCheck = null;
  api.setAlwaysOnTop.mockReset().mockResolvedValue(undefined);
  api.unlistenFocus.mockReset();
  api.focusHandler = null;
  api.onFocusChanged.mockReset().mockImplementation(async handler => {
    api.focusHandler = handler;
    return api.unlistenFocus;
  });
  api.invoke.mockReset();
  api.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "snapshot")
      return initialSnapshot ? await initialSnapshot : snapshot();
    if (command === "get_autostart") return false;
    if (command === "set_autostart") return args.enabled;
    if (command === "get_answer_memory") return {remember:true};
    if (command === "audio_sources") return [];
    if (command === "session_detail") return {answers:[],transcripts:[]};
    if (command === "app_data_path") return "fixture-data";
    if (command === "read_provider_secret")
      return args.providerId === "deepseek" && delayedKey
        ? await delayedKey
        : structuredClone(secrets[args.providerId]);
    if (command === "test_provider")
      return delayedCheck ? await delayedCheck : "连接成功 · 1 ms";
    if (command === "remove_provider") {
      const {withoutProvider}=await import("./lib/provider-presets");settings=withoutProvider(settings,args.id);delete secrets[args.id];return;
    }
    if (command === "save_preferences") { settings={...settings,...structuredClone(args.patch)};return; }
    if (command === "save_services") {
      const group=args.services.group;
      const belongs=(p:Settings["providers"][number])=>group==="model"?p.kind==="llm":group==="ocr"?["ocr","youdao-ocr","ocr-space"].includes(p.kind):["xfyun","tencent","dashscope","volcengine","openai-asr"].includes(p.kind);
      settings={...settings,providers:[...settings.providers.filter(p=>!belongs(p)),...structuredClone(args.services.providers)],[group==="model"?"activeModel":group==="asr"?"asrProvider":"ocrProvider"]:args.services.selected};
      if(group==="model"&&args.services.screenshotModel!==undefined)settings.screenshotModel=args.services.screenshotModel;
      for (const update of args.updates)
        secrets[update.id] = structuredClone(update.secret);
      return;
    }
    return;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});
async function closeService(user:ReturnType<typeof userEvent.setup>){
 const dialog=document.querySelector<HTMLElement>(".settings-service-dialog");if(dialog)await user.click(within(dialog).getByRole("button",{name:"关闭"}));
}
async function openService(user:ReturnType<typeof userEvent.setup>,name:string){
 await closeService(user);await user.click(await screen.findByRole("button",{name:`配置${name}`}));
}
async function settingsTab(user:ReturnType<typeof userEvent.setup>,name:string){
 await closeService(user);await user.click(screen.getByRole("tab",{name}));
 if(name==="服务"){await openService(user,"回答模型");const detail=screen.queryByText("接口设置",{exact:true});if(detail&&!detail.closest("details")?.open)await user.click(detail);}
}
async function settingsPage() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "设置" }));
  await openService(user,"回答模型");
  await screen.findByLabelText("模型 API Key");
  await user.click(screen.getByText("接口设置",{exact:true}));
  return user;
}
function modelCard() {
  return screen.getByRole("heading", { name: "回答模型" }).closest("section")!;
}
describe("settings credentials and checks", () => {
  it("keeps a draft and remasks keys when navigating with the keyboard from a collapsed sidebar", async () => {
    const user = await settingsPage();
    const base = screen.getByDisplayValue("https://saved.fixture.invalid/v1");
    await user.clear(base);
    await user.click(base);await user.paste("https://draft.fixture.invalid/v2");
    const model = screen.getByLabelText("模型 API Key") as HTMLInputElement;
    await user.click(within(model.parentElement!).getByRole("button", { name: "显示密钥" }));
    await closeService(user);await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(localStorage.getItem("interview-copilot.sidebar-collapsed")).toBe("true");
    expect(model.isConnected).toBe(false);
    await closeService(user);
    const navigation = screen.getByRole("navigation", { name: "页面" });
    within(navigation).getByRole("button", { name: "设置" }).focus();
    await user.keyboard("{Home}");
    expect(within(navigation).getByRole("button", { name: "开始面试" }).getAttribute("aria-current")).toBe("page");
    await user.keyboard("{End}");
    await openService(user,"回答模型");await user.click(screen.getByText("接口设置",{exact:true}));
    await screen.findByDisplayValue("https://draft.fixture.invalid/v2");
    expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).type).toBe("password");
    expect(api.invoke.mock.calls.some(([name]) => name === "save_services")).toBe(false);
  });
  it("preserves each credential and remasks it when changing the expanded service", async () => {
    const user=await settingsPage();const model=await screen.findByDisplayValue("saved-fixture-model-key") as HTMLInputElement;
    await user.click(within(model.parentElement!).getByRole("button",{name:"显示密钥"}));expect(model.type).toBe("text");
    await openService(user,"语音识别");const asr=await screen.findByLabelText("RTasr API Key") as HTMLInputElement;
    expect(asr.type).toBe("password");expect(asr.value).toBe("saved-fixture-asr-key");
    await user.click(within(asr.parentElement!).getByRole("button",{name:"显示密钥"}));expect(asr.type).toBe("text");
    await openService(user,"回答模型");const reopened=screen.getByLabelText("模型 API Key") as HTMLInputElement;
    expect(reopened.type).toBe("password");expect(reopened.value).toBe("saved-fixture-model-key");
    await openService(user,"语音识别");expect((screen.getByLabelText("RTasr API Key") as HTMLInputElement).type).toBe("password");
    await closeService(user);await user.click(screen.getByRole("button",{name:"开始面试"}));await user.click(screen.getByRole("button",{name:"设置"}));await openService(user,"回答模型");
    expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).type).toBe("password");
  });
  it("does not ask to save an unchanged configuration after a successful check",async()=>{
    const user=await settingsPage();await screen.findByDisplayValue("saved-fixture-model-key");await user.click(within(modelCard()).getByRole("button",{name:"检测"}));
    await within(modelCard()).findByText("连接成功 · 1 ms");expect(screen.queryByText(/请保存设置后用于面试/)).toBeNull();
    expect((screen.getByRole("button",{name:"保存"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("tests the replacement key and edited URL/model without using the saved key", async () => {
    const user = await settingsPage();
    const model = await screen.findByDisplayValue("saved-fixture-model-key");
    await user.clear(model);
    await user.paste("new-fixture-model-key");
    const base = screen.getByDisplayValue("https://saved.fixture.invalid/v1");
    await user.clear(base);
    await user.paste("https://current.fixture.invalid/v2");
    const name = screen.getByDisplayValue("saved-fixture-model");
    await user.clear(name);
    await user.paste("current-fixture-model");
    await user.click(
      within(modelCard()).getByRole("button", { name: "检测" }),
    );
    await screen.findByText("连接成功 · 1 ms");
    const call = api.invoke.mock.calls.find(
      ([name]) => name === "test_provider",
    );
    expect(call?.[1]).toEqual({
      providerId: "deepseek",
      provider: {
        ...settings.providers[1],
        baseUrl: "https://current.fixture.invalid/v2",
        model: "current-fixture-model",
      },
      secret: { apiKey: "new-fixture-model-key", secretKey: "" },
      network: settings.network,
    });
    expect(
      api.invoke.mock.calls.some(([name]) => name === "save_services"),
    ).toBe(false);
  });
  it("tests the current RTasr key rather than its saved value", async () => {
    const user = await settingsPage();
    await openService(user,"语音识别");
    await screen.findByDisplayValue("saved-fixture-asr-key");
    const asr = screen.getByLabelText("RTasr API Key");
    await user.clear(asr);
    await user.type(asr, "new-fixture-asr-key");
    const card = screen
      .getByRole("heading", { name: "语音识别" })
      .closest("section")!;
    await user.click(
      within(card).getByRole("button", { name: "检测" }),
    );
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.find(([name]) => name === "test_provider")?.[1]
          .secret.apiKey,
      ).toBe("new-fixture-asr-key"),
    );
  });
  it("keeps a provider failure local without a duplicate global notification", async () => {
    const original = api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "test_provider") throw new Error("fixture provider rejected");
      return original(command, args);
    });
    const user = await settingsPage();
    await user.type(screen.getByLabelText("模型 API Key"),"-edited");
    await user.click(within(modelCard()).getByRole("button", { name: "检测" }));
    await within(modelCard()).findByLabelText(/fixture provider rejected/);
    expect(document.querySelector(".toast-surface")).toBeNull();
    expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(false);
  });
  it("saves a replacement key and keeps its value hidden in the form", async () => {
    const user = await settingsPage();
    const model = (await screen.findByDisplayValue(
      "saved-fixture-model-key",
    )) as HTMLInputElement;
    await user.clear(model);
    await user.type(model, "new-saved-fixture-key");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/^设置已保存$/);
    expect(secrets.deepseek.apiKey).toBe("new-saved-fixture-key");
    expect(model.value).toBe("new-saved-fixture-key");
    expect(model.type).toBe("password");
  });
  it("does not create a default settings draft before the saved snapshot arrives", async () => {
    let release!: (value: Snapshot) => void;
    initialSnapshot = new Promise((resolve) => {
      release = resolve;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByText("正在读取已保存配置…")).toBeTruthy();
    release(snapshot());
    await openService(user,"语音识别");
    const app = await screen.findByDisplayValue("saved-fixture-app-id");
    expect((app as HTMLInputElement).value).toBe("saved-fixture-app-id");
  });
  it("never overwrites a new typed key with a late read of the old saved key", async () => {
    let release!: (value: { apiKey: string; secretKey: string }) => void;
    delayedKey = new Promise((resolve) => {
      release = resolve;
    });
    const user = await settingsPage();
    const model = screen.getByLabelText("模型 API Key") as HTMLInputElement;
    await user.type(model, "typed-before-load-fixture-key");
    release({ apiKey: "late-old-fixture-key", secretKey: "" });
    await waitFor(() =>
      expect(model.value).toBe("typed-before-load-fixture-key"),
    );
  });
  it("does not mark a just-saved replacement key dirty when an older credential read finishes late",async()=>{
    let release!:(value:{apiKey:string;secretKey:string})=>void;delayedKey=new Promise(resolve=>{release=resolve;});
    const user=await settingsPage();const model=screen.getByLabelText("模型 API Key") as HTMLInputElement;
    await user.type(model,"fresh-saved-fixture");await user.click(screen.getByRole("button",{name:"保存"}));await screen.findByText(/^设置已保存$/);
    await act(async()=>release({apiKey:"outdated-fixture",secretKey:""}));expect(model.value).toBe("fresh-saved-fixture");
    expect((screen.getByRole("button",{name:"保存"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("discards a late authentication error after the input key changes", async () => {
    let reject!: (reason: Error) => void;
    delayedCheck = new Promise((_, fail) => {
      reject = fail;
    });
    const user = await settingsPage();
    const model = await screen.findByDisplayValue("saved-fixture-model-key");
    await user.click(
      within(modelCard()).getByRole("button", { name: "检测" }),
    );
    await screen.findByText("正在检测当前输入…");
    await user.clear(model);
    await user.type(model, "replacement-fixture-key");
    reject(new Error("fixture-old-key-401"));
    await waitFor(() =>
      expect(
        (
          within(modelCard()).getByRole("button", {
            name: "检测",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/fixture-old-key-401/)).toBeNull();
  });
});

describe("focused settings and data tools",()=>{
 it("searches settings, previews reading size, and keeps the draft without saving",async()=>{
  const user=await settingsPage();await closeService(user);const search=screen.getByRole("textbox",{name:"搜索设置"});await user.type(search,"字号");
  expect(screen.queryByRole("tab",{name:"服务"})).toBeNull();const font=screen.getByLabelText("答案字号");await user.clear(font);await user.type(font,"28");
  expect(screen.queryByLabelText("答案阅读预览")).toBeNull();expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
  await user.clear(search);await settingsTab(user,"服务");await settingsTab(user,"偏好");
  expect((screen.getByLabelText("答案字号") as HTMLInputElement).value).toBe("28");
 });
 it("prevents saving an invalid reading size while retaining an uncluttered preview",async()=>{
  const user=await settingsPage();await settingsTab(user,"偏好");const size=screen.getByLabelText("答案字号");await user.clear(size);await user.type(size,"31");
  expect(size.getAttribute("aria-invalid")).toBe("true");expect(screen.queryByRole("button",{name:"保存"})).toBeNull();
  await user.clear(size);await user.type(size,"30");expect(size.getAttribute("aria-invalid")).toBe("false");expect(screen.queryByRole("alert")).toBeNull();
 });
 it("shows shortcut conflicts before saving and lets Tab move to the next input",async()=>{
  const user=await settingsPage();await settingsTab(user,"快捷键");const answer=screen.getByLabelText("立即回答");
  fireEvent.keyDown(answer,{key:"Backspace",code:"Backspace",ctrlKey:true,altKey:true});expect(answer.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getAllByRole("alert")).toHaveLength(2);expect(screen.queryByRole("button",{name:"保存"})).toBeNull();
  fireEvent.keyDown(answer,{key:"a",code:"KeyA",ctrlKey:true,altKey:true});expect(screen.queryByRole("alert")).toBeNull();
  answer.focus();await user.tab();expect(document.activeElement).toBe(screen.getByRole("button",{name:"停用立即回答快捷键"}));await user.tab();expect(document.activeElement).toBe(screen.getByLabelText("停止生成"));
  await waitFor(()=>expect(settings.shortcuts.answer).toBe("Ctrl+Alt+A"));
 });
 it("keeps window memory unchanged after a failed preference write",async()=>{
  const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="get_answer_memory"?Promise.resolve({remember:false}):name==="set_answer_memory"?Promise.reject(new Error("fixture preference read-only")):normal(name,args));
  const user=await settingsPage();await settingsTab(user,"偏好");const toggle=screen.getByRole("switch",{name:"记住答案窗位置与大小"});expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.click(toggle);await screen.findByText(/fixture preference read-only/);expect(toggle.getAttribute("aria-checked")).toBe("false");expect(settings.fontSize).toBe(14);
 });
 it("creates a chosen data backup and does nothing when the save picker is cancelled",async()=>{
  const dialogs=await import("@tauri-apps/plugin-dialog");vi.mocked(dialogs.save).mockResolvedValueOnce(null).mockResolvedValueOnce("C:/fixture/data.cuvilo-backup");
  const user=await settingsPage();await settingsTab(user,"数据");await user.click(screen.getByRole("button",{name:"创建备份"}));
  expect(api.invoke.mock.calls.some(([name])=>name==="create_data_backup")).toBe(false);await user.click(screen.getByRole("button",{name:"创建备份"}));
  await waitFor(()=>expect(api.invoke.mock.calls.find(([name])=>name==="create_data_backup")?.[1]).toEqual({path:"C:/fixture/data.cuvilo-backup"}));
  expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("previews restore counts, requires confirmation, keeps local failures for retry and releases cancelled previews",async()=>{
  const dialogs=await import("@tauri-apps/plugin-dialog");vi.mocked(dialogs.open).mockResolvedValue("C:/fixture/data.cuvilo-backup");
  const normal=api.invoke.getMockImplementation()!;let fail=true;
  api.invoke.mockImplementation((name,args)=>{if(name==="preview_data_restore")return Promise.resolve({token:"preview-fixture",createdAt:1,materials:2,sessions:3,answers:4,transcripts:5});if(name==="restore_data_backup"){if(fail){fail=false;return Promise.reject(new Error("fixture restore rollback"));}return Promise.resolve();}return normal(name,args);});
  const user=await settingsPage();await settingsTab(user,"数据");const trigger=screen.getByRole("button",{name:"选择备份"});await user.click(trigger);
  let dialog=await screen.findByRole("alertdialog",{name:"恢复这份备份？"});expect(dialogs.open).toHaveBeenLastCalledWith(expect.objectContaining({defaultPath:"fixture-data",multiple:false}));expect(dialog.textContent).toContain("2 份材料");expect(api.invoke.mock.calls.some(([name])=>name==="restore_data_backup")).toBe(false);
  await user.click(within(dialog).getByRole("button",{name:"取消"}));await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());expect(document.activeElement).toBe(trigger);
  expect(api.invoke.mock.calls.find(([name])=>name==="discard_data_restore")?.[1]).toEqual({token:"preview-fixture"});
  await user.click(trigger);dialog=await screen.findByRole("alertdialog");await user.click(within(dialog).getByRole("button",{name:"确认恢复"}));await within(dialog).findByText(/fixture restore rollback/);
  expect(document.querySelector(".toast-surface[data-kind=error]")).toBeNull();await user.click(within(dialog).getByRole("button",{name:"确认恢复"}));await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.invoke.mock.calls.filter(([name])=>name==="restore_data_backup")).toHaveLength(2);expect(document.activeElement).toBe(trigger);
 });
 it("rejects an unreadable backup locally without invoking restore",async()=>{
  const dialogs=await import("@tauri-apps/plugin-dialog");vi.mocked(dialogs.open).mockResolvedValue("C:/fixture/bad.cuvilo-backup");const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="preview_data_restore"?Promise.reject(new Error("fixture corrupt backup")):normal(name,args));
  const user=await settingsPage();await settingsTab(user,"数据");await user.click(screen.getByRole("button",{name:"选择备份"}));await screen.findByText(/fixture corrupt backup/);
  expect(screen.queryByRole("alertdialog")).toBeNull();expect(api.invoke.mock.calls.some(([name])=>name==="restore_data_backup")).toBe(false);
 });
});

describe("desktop UI integration", () => {
  it("defaults to system audio, preserves a manually selected source on refresh and starts with it", async () => {
    const source = { id: "fixture-meeting", name: "fixture meeting", kind: "process", pid: 123, recommended: true };
    const otherSource = { id: "fixture-system", name: "fixture system audio", kind: "system", pid: null, recommended: false };
    const originalInvoke = api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async (command: string, args: any) => command === "audio_sources" ? [source, otherSource] : originalInvoke(command, args));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "调整会议音源" }));
    const select = await screen.findByLabelText("会议音源");
    await waitFor(() => expect(select.textContent).toContain(otherSource.name));
    expect(screen.queryByText("未开始")).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    await user.click(select);
    await user.click(screen.getByRole("option", { name: source.name + " · 推荐" }));
    const beforeRefresh = api.invoke.mock.calls.filter(([name]) => name === "audio_sources").length;
    await user.click(screen.getByRole("button", { name: "刷新音源" }));
    await waitFor(() => expect(api.invoke.mock.calls.filter(([name]) => name === "audio_sources").length).toBe(beforeRefresh + 1));
    expect(select.textContent).toContain(source.name);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button",{name:"本次面试选项"}));await user.type(screen.getByLabelText("会话名称"), "fixture interview");await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "转写我的回答" }));
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: /^开始面试$/ }));
    await waitFor(() => expect(api.invoke.mock.calls.find(([name]) => name === "start_session")?.[1]).toEqual({
      options: { source, microphone: true, title: "fixture interview" },
    }));
    expect(api.invoke.mock.calls.some(([name]) => name === "show_answer")).toBe(false);
  });
  it("shows an intentional End hint and calls stop rather than hide", async () => {
    window.history.replaceState({}, "", "/?window=answer");
    const user=userEvent.setup();render(<App />);
    const end=await screen.findByRole("button",{name:"结束"});
    end.focus();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,160));});
    expect(end.getAttribute("data-variant")).toBe("destructive");
    expect(end.getAttribute("title")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(end,{clientX:440,clientY:20});await user.hover(end);
    await screen.findByRole("tooltip");expect(screen.getByRole("tooltip").textContent).toBe("结束");
    await user.click(end);
    await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="stop_session")).toBe(true));
  });
  it("navigates a rounded select with the keyboard and Escape does not commit a highlighted option", async () => {
    const user = await settingsPage();
    await settingsTab(user,"偏好");
    await user.click(screen.getByText("网络",{exact:true}));
    const trigger = screen.getByRole("combobox", { name: "代理" });
    expect(trigger.textContent).toContain("直接连接");
    await user.click(trigger);
    await screen.findByRole("listbox");
    await user.keyboard("{End}{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(trigger.textContent).toContain("直接连接");
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await user.keyboard("{End}{Enter}");
    await screen.findByLabelText("地址");
    expect(trigger.textContent).toContain("手动代理");
    expect(api.invoke.mock.calls.some(([name]) => name === "save_services")).toBe(false);
  });
  it("keeps the manual question draft when its answer-window dialog is reopened", async () => {
    window.history.replaceState({}, "", "/?window=answer");
    initialSnapshot = Promise.resolve({ ...snapshot(), session: { id: "demo-session", title: "fixture session", createdAt: 1, endedAt: null }, answers: structuredClone(previewAnswers), transcripts: structuredClone(previewTranscripts) });
    const user=userEvent.setup();render(<App />);
    await screen.findByRole("button",{name:"立即回答"});
    await user.click(screen.getByRole("button",{name:"更多"}));
    await user.click(screen.getByRole("menuitem",{name:"手动提问"}));
    await user.type(await screen.findByRole("textbox",{name:"手动输入问题"}),"fixture follow-up");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button",{name:"更多"}));
    await user.click(screen.getByRole("menuitem",{name:"手动提问"}));
    expect((await screen.findByRole("textbox",{name:"手动输入问题"}) as HTMLTextAreaElement).value).toBe("fixture follow-up");
    expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(false);
  });
  it("keeps Shift+Enter as a newline and submits the complete multiline question with Enter", async () => {
    initialSnapshot = Promise.resolve({...snapshot(),session:{id:"fixture-session",title:"fixture",createdAt:1,endedAt:null}});
    window.history.replaceState({}, "", "/?window=answer");
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"更多"}));
    await user.click(screen.getByRole("menuitem",{name:"手动提问"}));
    const input=await screen.findByRole("textbox",{name:"手动输入问题"});
    await user.type(input,"第一行{Shift>}{Enter}{/Shift}第二行");
    expect((input as HTMLTextAreaElement).value).toBe("第一行\n第二行");
    expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(false);
    await user.keyboard("{Enter}");
    await waitFor(()=>expect(api.invoke.mock.calls.some(([name,args])=>name==="request_answer" && args.text==="第一行\n第二行")).toBe(true));
    await waitFor(()=>expect((input as HTMLTextAreaElement).value).toBe(""));
  });
  it("cancels a streamed answer from the answer toolbar without submitting another question", async () => {
    initialSnapshot = Promise.resolve({...snapshot(),session:{id:"demo-session",title:"fixture",createdAt:1,endedAt:null},answers:[{...previewAnswers[0],status:"generating"}]});
    window.history.replaceState({}, "", "/?window=answer");
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"停止生成"}));
    await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="cancel_answer")).toBe(true));
    expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(false);
  });
  it("keeps unsaved values when changing settings tabs and saves them together", async () => {
    const user = await settingsPage();
    const key = await screen.findByDisplayValue("saved-fixture-model-key");
    await user.clear(key);
    await user.paste("tab-fixture-key");
    await settingsTab(user,"偏好");
    const job = screen.getByLabelText("答案字号");
    await user.clear(job);
    await user.paste("22");
    await settingsTab(user,"偏好");
    await user.click(screen.getByText("网络",{exact:true}));
    await user.click(screen.getByRole("combobox", { name: "代理" }));
    await user.click(screen.getByRole("option", { name: "手动代理" }));
    await user.click(screen.getByLabelText("地址"));await user.paste("http://127.0.0.1:7890");
    await settingsTab(user,"服务");
    expect(
      (screen.getByLabelText("模型 API Key") as HTMLInputElement).value,
    ).toBe("tab-fixture-key");
    expect(
      (screen.getByLabelText("模型 API Key") as HTMLInputElement).type,
    ).toBe("password");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/^设置已保存$/);
    await waitFor(()=>expect(settings.fontSize).toBe(22));
    await waitFor(()=>expect(settings.network).toEqual({
      mode: "manual",
      url: "http://127.0.0.1:7890",
    }));
    expect(secrets.deepseek.apiKey).toBe("tab-fixture-key");
  });
  it("closes the material editor with Escape, restores focus and submits edited content", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "个人材料" }));
    const trigger = screen.getByRole("button", { name: "新建材料" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "确认材料内容" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByLabelText("材料标题"),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.type(screen.getByLabelText("材料标题"), "fixture project");
    await user.type(
      screen.getByLabelText("材料内容"),
      "fixture confirmed experience",
    );
    await user.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.find(([name]) => name === "save_material")?.[1]
          .material,
      ).toMatchObject({
        title: "fixture project",
        text: "fixture confirmed experience",
        kind: "project",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("only requests material deletion after confirmation", async () => {
    initialSnapshot = Promise.resolve({
      ...snapshot(),
      materials: [
        {
          id: "fixture-material",
          title: "fixture resume",
          kind: "resume",
          text: "fixture text",
          enabled: true,
          updatedAt: 1,
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "个人材料" }));
    const remove = await screen.findByRole("button", {
      name: "删除材料：fixture resume",
    });
    await user.click(remove);
    await screen.findByRole("alertdialog", { name: "删除这份材料？" });
    expect(
      api.invoke.mock.calls.some(([name]) => name === "delete_material"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(remove);
    await user.click(remove);
    await user.click(screen.getByRole("button", { name: "删除材料" }));
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.find(([name]) => name === "delete_material")?.[1],
      ).toEqual({ id: "fixture-material" }),
    );
  });
  it("manages filtered materials in bulk and submits one confirmed request", async () => {
    const material=(id:string,title:string)=>({id,title,kind:"project",text:"fixture text",enabled:true,updatedAt:1});
    let records=[material("a","Java first"),material("b","Java second"),material("c","Python keep")];
    const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),materials:[...records]};
      if(command==="delete_materials"){records=records.filter(item=>!args.ids.includes(item.id));return;}
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"个人材料"}));
    await user.click(await screen.findByRole("button",{name:"批量管理"}));
    const search=screen.getByRole("textbox",{name:"搜索材料"});await user.type(search,"Java");
    await user.click(screen.getByRole("checkbox",{name:"全选当前材料"}));
    expect(screen.getByText("已选 2 份")).toBeTruthy();
    const remove=screen.getByRole("button",{name:"删除所选（2）"});await user.click(remove);
    await screen.findByRole("heading",{name:"删除这 2 份材料？"});
    const confirm=screen.getByRole("button",{name:"删除材料"});expect(confirm.getAttribute("data-variant")).toBe("destructive");
    await user.click(screen.getByRole("button",{name:"取消"}));await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(remove);expect(api.invoke.mock.calls.some(([name])=>name==="delete_materials")).toBe(false);
    await user.click(remove);await user.click(screen.getByRole("button",{name:"删除材料"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.invoke.mock.calls.filter(([name])=>name==="delete_materials")).toHaveLength(1);
    expect(api.invoke.mock.calls.find(([name])=>name==="delete_materials")?.[1]).toEqual({ids:["a","b"]});
    await user.clear(search);expect(screen.getByRole("heading",{name:"Python keep"})).toBeTruthy();
    expect(screen.queryByRole("heading",{name:"Java first"})).toBeNull();
  });
  it("retains material selection and errors when batch deletion fails", async () => {
    const materials=[{id:"a",title:"fixture a",kind:"project",text:"text",enabled:true,updatedAt:1}];
    const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),materials};
      if(command==="delete_materials")throw new Error("fixture material rollback");
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"个人材料"}));
    await user.click(await screen.findByRole("button",{name:"批量管理"}));await user.click(screen.getByRole("checkbox",{name:"全选当前材料"}));
    await user.click(screen.getByRole("button",{name:"删除所选（1）"}));await user.click(screen.getByRole("button",{name:"删除材料"}));
    await screen.findByText(/fixture material rollback/);expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button",{name:"取消"}));await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByRole("checkbox",{name:"选择材料：fixture a"}) as HTMLInputElement).checked).toBe(true);
  });
  it("searches history by name or date and selects only visible search results", async () => {
    const sessions=[{id:"a",title:"Cache interview",createdAt:new Date(2026,9,19,10).getTime(),endedAt:1},{id:"b",title:"Database interview",createdAt:new Date(2026,9,18,10).getTime(),endedAt:1}];
    initialSnapshot=Promise.resolve({...snapshot(),sessions});
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"历史记录"}));
    expect(screen.queryByRole("button",{name:"刷新记录"})).toBeNull();
    const search=screen.getByRole("textbox",{name:"搜索历史记录"});await user.type(search,"cache");
    expect(screen.getByRole("button",{name:/^Cache interview/})).toBeTruthy();expect(screen.queryByRole("button",{name:/^Database interview/})).toBeNull();
    await user.click(screen.getByRole("button",{name:"批量管理"}));await user.click(screen.getByRole("checkbox",{name:"全选可删除记录"}));
    expect(screen.getByText("已选 1 条")).toBeTruthy();await user.clear(search);
    expect((screen.getByRole("checkbox",{name:"选择记录：Database interview"}) as HTMLInputElement).checked).toBe(false);
    await user.type(search,"10/18");expect(screen.getByRole("button",{name:/^Database interview/})).toBeTruthy();expect(screen.queryByRole("button",{name:/^Cache interview/})).toBeNull();
    await user.clear(search);await user.type(search,"no such result");await screen.findByRole("heading",{name:"没有匹配的记录"});
  });
  it("shows a quiet preparation home and only a start action before an interview", async () => {
    const view=render(<App />);await screen.findByRole("region",{name:"会前准备"});
    expect(screen.getByLabelText("目标岗位")).toBeTruthy();
    expect(screen.getByText("暂无面试记录")).toBeTruthy();
    expect(screen.queryByLabelText("会议音源")).toBeNull();
    expect(within(screen.getByRole("main")).getAllByRole("button",{name:"开始面试"})).toHaveLength(1);
    expect(screen.queryByRole("textbox",{name:"手动输入问题"})).toBeNull();
    expect(screen.queryByRole("button",{name:"结束面试"})).toBeNull();
    expect(screen.queryByRole("button",{name:"答案窗口"})).toBeNull();
    expect(view.container.querySelector(".composer-tools kbd")).toBeNull();
  });
  it("does not submit a manual question when Enter confirms Chinese composition", async () => {
    initialSnapshot = Promise.resolve({
      ...snapshot(),
      session: {
        id: "demo-session",
        title: "fixture session",
        createdAt: 1,
        endedAt: null,
      },
    });
    window.history.replaceState({}, "", "/?window=answer");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button",{name:"更多"}));
    await user.click(screen.getByRole("menuitem",{name:"手动提问"}));
    const input = await screen.findByRole("textbox", { name: "手动输入问题" });
    await user.type(input, "缓存如何实现");
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    expect(
      api.invoke.mock.calls.some(([name]) => name === "request_answer"),
    ).toBe(false);
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: false,
    });
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.find(([name]) => name === "request_answer")?.[1],
      ).toEqual({ text: "缓存如何实现", questionId: null, mode: "short" }),
    );
  });
  it("keeps the scroll position while reading earlier questions and preserves reading controls", async () => {
    window.history.replaceState({}, "", "/?window=answer");
    initialSnapshot = Promise.resolve({
      ...snapshot(),
      session: {
        id: "demo-session",
        title: "fixture session",
        createdAt: 1,
        endedAt: null,
      },
      answers: structuredClone(previewAnswers),
      transcripts: structuredClone(previewTranscripts),
    });
    const user = userEvent.setup();
    const rendered = render(<App />);
    await screen.findByRole("heading", { name: previewAnswers[1].question });
    const viewport = screen.getByRole("log", { name: "问题与答案" });
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    viewport.scrollTop = 800;
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(
      (screen.getByRole("button", { name: "减小字号" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "增大字号" }));
    expect(
      (rendered.container.querySelector(".answer-markdown") as HTMLElement)
        .style.fontSize,
    ).toBe("15px");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "暂停自动跟随" }));
    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    const next = {
      ...previewAnswers[1],
      id: "a3",
      questionId: "q3",
      question: "fixture new follow-up",
      createdAt: previewAnswers[1].createdAt + 1,
    };
    act(() =>
      api.channel?.onmessage({
        type: "answer",
        sessionId: "demo-session",
        answer: next,
      }),
    );
    expect(
      screen.getByRole("heading", { name: previewAnswers[1].question }),
    ).toBeTruthy();
    expect(viewport.scrollTop).toBe(120);
    expect(screen.getAllByRole("article")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "1 条新问题" }));
    expect(viewport.scrollTop).toBe(800);
    expect(screen.getByRole("heading", { name: next.question })).toBeTruthy();
    const earlier = screen.getByRole("heading", { name: previewAnswers[1].question }).closest("article")!;
    await user.click(within(earlier).getByRole("button", { name: "答案操作" }));
    await user.click(screen.getByRole("menuitem", { name: "展开解释" }));
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.find(([name]) => name === "request_answer")?.[1],
      ).toEqual({
        text: previewAnswers[1].question,
        questionId: previewAnswers[1].questionId,
        mode: "detail",
      }),
    );
    expect(screen.queryByRole("button", { name: "转写" })).toBeNull();
    expect(screen.queryByRole("region", { name: "实时转写" })).toBeNull();
  });
  it("shows copy success inside the button briefly without a toast or layout change", async () => {
    window.history.replaceState({}, "", "/?window=answer");
    initialSnapshot = Promise.resolve({...snapshot(),answers:structuredClone(previewAnswers)});
    const user=userEvent.setup();render(<App />);
    const copy=await screen.findAllByRole("button",{name:"复制答案"});
    const write=vi.spyOn(navigator.clipboard,"writeText").mockResolvedValue();
    await user.click(copy[0]);
    await screen.findByRole("button",{name:"已复制"});
    expect(write).toHaveBeenCalledWith(previewAnswers[0].text);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("已复制")).toBeNull();
    await waitFor(()=>expect(screen.queryByRole("button",{name:"已复制"})).toBeNull(),{timeout:2000});
    expect(screen.getAllByRole("button",{name:"复制答案"})).toHaveLength(2);
    write.mockRestore();
  });
  it("confirms history deletion and clears the selected detail without removing other sessions", async () => {
    const first={id:"delete-history",title:"fixture delete history",createdAt:1,endedAt:2};
    const keep={id:"keep-history",title:"fixture keep history",createdAt:3,endedAt:4};
    let records=[first,keep];const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),sessions:[...records]};
      if(command==="session_detail")return {transcripts:[],answers:[{...previewAnswers[0],sessionId:args.id}]};
      if(command==="delete_session"){records=records.filter(item=>item.id!==args.id);return;}
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"历史记录"}));
    await user.click(await screen.findByRole("button",{name:/^fixture delete history/}));
    await screen.findByRole("heading",{name:name=>name.includes(previewAnswers[0].question)});
    const trigger=screen.getByRole("button",{name:"记录操作：fixture delete history"});
    await user.click(trigger);await user.click(screen.getByRole("menuitem",{name:"删除记录"}));await screen.findByRole("alertdialog");
    expect(api.invoke.mock.calls.some(([name])=>name==="delete_session")).toBe(false);
    await user.click(screen.getByRole("button",{name:"取消"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);await user.click(screen.getByRole("menuitem",{name:"删除记录"}));await user.click(screen.getByRole("button",{name:"删除记录"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.invoke.mock.calls.find(([name])=>name==="delete_session")?.[1]).toEqual({id:first.id});
    expect(screen.queryByRole("button",{name:/^fixture delete history/})).toBeNull();
    expect(screen.getByRole("button",{name:/^fixture keep history/})).toBeTruthy();
    await waitFor(()=>expect(screen.getByRole("button",{name:/^fixture keep history/}).getAttribute("aria-current")).toBe("true"));
  });
  it("keeps a failed history deletion open and disables deletion for the active interview", async () => {
    const active={id:"active-history",title:"fixture active history",createdAt:1,endedAt:null};
    const old={id:"old-history",title:"fixture old history",createdAt:2,endedAt:3};
    const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),session:active,sessions:[active,old]};
      if(command==="delete_session")throw new Error("fixture database error");
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"历史记录"}));
    await user.click(screen.getByRole("button",{name:"记录操作：fixture active history"}));
    expect(screen.getByRole("menuitem",{name:"删除记录"}).getAttribute("data-disabled")).not.toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button",{name:"记录操作：fixture old history"}));
    await user.click(screen.getByRole("menuitem",{name:"删除记录"}));
    await user.click(screen.getByRole("button",{name:"删除记录"}));
    await screen.findByText(/fixture database error/);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(within(screen.getByRole("alertdialog")).getByRole("alert").textContent).toContain("fixture database error");
    await user.click(screen.getByRole("button",{name:"取消"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("button",{name:/^fixture old history/})).toBeTruthy();
  });
  it("selects history in bulk, excludes the active interview and deletes selected records with one request", async () => {
    const active={id:"active",title:"fixture active",createdAt:1,endedAt:null};
    const first={id:"batch-first",title:"fixture first",createdAt:2,endedAt:3};
    const second={id:"batch-second",title:"fixture second",createdAt:4,endedAt:5};
    const keep={id:"batch-keep",title:"fixture keep",createdAt:6,endedAt:7};
    let records=[active,first,second,keep];const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),session:active,sessions:[...records]};
      if(command==="session_detail")return {transcripts:[],answers:[{...previewAnswers[0],sessionId:args.id}]};
      if(command==="delete_sessions"){records=records.filter(item=>!args.ids.includes(item.id));return;}
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"历史记录"}));
    await user.click(await screen.findByRole("button",{name:/^fixture first/}));
    await screen.findByRole("heading",{name:name=>name.includes(previewAnswers[0].question)});
    await user.click(screen.getByRole("button",{name:"批量管理"}));
    expect((screen.getByRole("checkbox",{name:"选择记录：fixture active"}) as HTMLInputElement).disabled).toBe(true);
    const all=screen.getByRole("checkbox",{name:"全选可删除记录"});
    await user.click(screen.getByRole("checkbox",{name:"选择记录：fixture first"}));
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    await user.click(all);
    expect(screen.getByText("已选 3 条")).toBeTruthy();
    await user.click(screen.getByRole("checkbox",{name:"选择记录：fixture keep"}));
    const trigger=screen.getByRole("button",{name:"删除所选（2）"});
    await user.click(trigger);await screen.findByRole("heading",{name:"删除这 2 条记录？"});
    await user.click(screen.getByRole("button",{name:"取消"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(api.invoke.mock.calls.some(([name])=>name==="delete_sessions")).toBe(false);
    await user.click(trigger);await user.click(screen.getByRole("button",{name:"删除记录"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.invoke.mock.calls.filter(([name])=>name==="delete_sessions")).toHaveLength(1);
    expect([...api.invoke.mock.calls.find(([name])=>name==="delete_sessions")![1].ids].sort()).toEqual([first.id,second.id].sort());
    expect(screen.queryByRole("checkbox",{name:"选择记录：fixture first"})).toBeNull();
    expect(screen.getByRole("checkbox",{name:"选择记录：fixture keep"})).toBeTruthy();
    await waitFor(()=>expect(screen.getByRole("button",{name:/^fixture keep/}).getAttribute("aria-current")).toBe("true"));
  });
  it("can leave bulk management after deleting every record and restores a usable focus target", async () => {
    let records=[{id:"last",title:"fixture last",createdAt:1,endedAt:2}];
    const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),sessions:[...records]};
      if(command==="delete_sessions"){records=[];return;}
      return original(command,args);
    });
    const user=userEvent.setup();const view=render(<App />);
    await user.click(await screen.findByRole("button",{name:"历史记录"}));
    await user.click(await screen.findByRole("button",{name:"批量管理"}));
    await user.click(screen.getByRole("checkbox",{name:"全选可删除记录"}));
    await user.click(screen.getByRole("button",{name:"删除所选（1）"}));
    await user.click(screen.getByRole("button",{name:"删除记录"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("heading",{name:"暂无面试记录"})).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button",{name:"完成"}));
    const done=screen.getByRole("button",{name:"完成"});expect((done as HTMLButtonElement).disabled).toBe(false);
    await user.click(done);expect(screen.queryByRole("button",{name:"批量管理"})).toBeNull();
  });
  it("keeps batch selection and the confirmation open when atomic deletion fails", async () => {
    const records=[{id:"a",title:"fixture a",createdAt:1,endedAt:2},{id:"b",title:"fixture b",createdAt:3,endedAt:4}];
    const original=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async(command:string,args:any)=>{
      if(command==="snapshot")return {...snapshot(),sessions:records};
      if(command==="delete_sessions")throw new Error("fixture batch rollback");
      return original(command,args);
    });
    const user=userEvent.setup();render(<App />);
    await user.click(await screen.findByRole("button",{name:"历史记录"}));
    await user.click(screen.getByRole("button",{name:"批量管理"}));
    await user.click(screen.getByRole("checkbox",{name:"全选可删除记录"}));
    await user.click(screen.getByRole("button",{name:"删除所选（2）"}));
    await user.click(screen.getByRole("button",{name:"删除记录"}));
    await screen.findByText(/fixture batch rollback/);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button",{name:"取消"}));
    await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("已选 2 条")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").every(box=>(box as HTMLInputElement).checked)).toBe(true);
  });
  it("starts pinned, toggles the native pin state and retains it after a native failure", async () => {
    window.history.replaceState({},"","/?window=answer");
    const user=userEvent.setup();render(<App />);
    const pin=await screen.findByRole("button",{name:"取消置顶"});
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    await user.click(pin);
    const unpinned=await screen.findByRole("button",{name:"置顶窗口"});
    expect(unpinned.getAttribute("aria-pressed")).toBe("false");
    expect(api.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    await user.click(unpinned);await screen.findByRole("button",{name:"取消置顶"});
    expect(api.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    api.setAlwaysOnTop.mockRejectedValueOnce(new Error("fixture pin failed"));
    await user.click(screen.getByRole("button",{name:"取消置顶"}));
    await screen.findByText(/fixture pin failed/);
    expect(screen.getByRole("button",{name:"取消置顶"}).getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps navigation nodes for a reversible collapse and uses the product mark in both waiting views", async () => {
    const user=userEvent.setup();const rendered=render(<App />);
    await screen.findByRole("region",{name:"会前准备"});
    const brand=rendered.container.querySelector(".preparation-empty img") as HTMLImageElement;
    expect(brand.getAttribute("src")).toBe("/brand/mark.svg");
    const nav=screen.getByRole("navigation",{name:"页面"});
    const original=within(nav).getByRole("button",{name:"个人材料"});
    const label=original.querySelector(".navigation-label")!;
    await user.click(screen.getByRole("button",{name:"收起侧栏"}));
    expect(within(nav).getByRole("button",{name:"个人材料"})).toBe(original);
    expect(label.isConnected).toBe(true);
    expect(label.getAttribute("aria-hidden")).toBe("true");
    await user.click(screen.getByRole("button",{name:"展开侧栏"}));
    expect(within(nav).getByRole("button",{name:"个人材料"})).toBe(original);
    expect(label.getAttribute("aria-hidden")).toBe("false");
    rendered.unmount();window.history.replaceState({},"","/?window=answer");
    const answer=render(<App />);await screen.findByRole("heading",{name:"等待提问"});
    expect(answer.container.querySelector(".empty-state-brand img")?.getAttribute("src")).toBe("/brand/mark.svg");
  });
  it("dismisses navigation hints on window blur and does not reopen them on restored focus", async () => {
    localStorage.setItem("interview-copilot.sidebar-collapsed", "true");
    const user=userEvent.setup();const view=render(<App />);
    await screen.findByRole("region",{name:"会前准备"});
    const material=screen.getByRole("button",{name:"个人材料"});
    await user.hover(material);await screen.findByRole("tooltip");
    expect(screen.getByRole("tooltip").textContent).toBe("个人材料");
    fireEvent(window,new Event("blur"));await waitFor(()=>expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent(window,new Event("focus"));fireEvent.focus(material);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,160));});
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.unhover(material);fireEvent.pointerMove(material,{clientX:30,clientY:100});
    await screen.findByRole("tooltip");
    act(() => api.focusHandler?.({payload:false}));await waitFor(()=>expect(screen.queryByRole("tooltip")).toBeNull());
    act(() => api.focusHandler?.({payload:true}));fireEvent.focus(material);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,120));});
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document,{key:"Tab"});fireEvent.focus(material);
    await screen.findByRole("tooltip");expect(screen.getByRole("tooltip").textContent).toBe("个人材料");
    view.unmount();expect(api.unlistenFocus).toHaveBeenCalledTimes(1);
  });
  it("keeps the material empty state compact and preserves the import action", async () => {
    const user=userEvent.setup();const view=render(<App />);
    await user.click(await screen.findByRole("button",{name:"个人材料"}));
    const empty=await screen.findByRole("region",{name:"导入材料"});
    expect(within(empty).queryByRole("heading")).toBeNull();
    expect(screen.queryByText("从一份简历开始")).toBeNull();
    expect(empty.textContent).toContain("或拖入 PDF、DOCX、TXT、MD");
    expect(empty.querySelector(".empty-state-icon")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "搜索材料" })).toBeNull();
    expect(screen.queryByRole("button", { name: "批量管理" })).toBeNull();
    expect(empty.querySelector("svg")).not.toBeNull();
    expect(view.container.querySelector(".materials-empty .panel")).toBeNull();
    const dialogs = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialogs.open).mockClear();
    await user.click(within(empty).getByRole("button",{name:"导入材料"}));
    expect(dialogs.open).toHaveBeenCalledTimes(1);
  });
  it("uses one shared tooltip for reading controls without breaking menu focus", async () => {
    window.history.replaceState({},"","/?window=answer");
    const user=userEvent.setup();render(<App />);
    const pin=await screen.findByRole("button",{name:"取消置顶"});
    const reading=screen.getByRole("button",{name:"更多"});
    expect(pin.getAttribute("title")).toBeNull();expect(reading.getAttribute("title")).toBeNull();
    await user.hover(pin);await screen.findByRole("tooltip");
    expect(screen.getByRole("tooltip").textContent).toBe("取消置顶");
    await user.unhover(pin);await waitFor(()=>expect(screen.queryByRole("tooltip")).toBeNull());
    await user.hover(reading);await screen.findByRole("tooltip");
    expect(screen.getByRole("tooltip").textContent).toBe("更多");
    await user.click(reading);await screen.findByRole("menu");
    await user.keyboard("{Escape}");await waitFor(()=>expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(reading);
  });
  it("updates a question in place, preserves paused reading during streaming, and resumes for a new session", async () => {
    window.history.replaceState({}, "", "/?window=answer");
    initialSnapshot = Promise.resolve({ ...snapshot(),
      session: { id: "demo-session", title: "fixture session", createdAt: 1, endedAt: null },
      answers: structuredClone(previewAnswers),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: previewAnswers[1].question });
    const viewport = screen.getByRole("log", { name: "问题与答案" });
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    viewport.scrollTop = 40;
    fireEvent.scroll(viewport);
    const update = { ...previewAnswers[0], id: "revision", revision: 2, createdAt: previewAnswers[1].createdAt + 10, status: "generating", text: "fixture partial text" };
    act(() => api.channel?.onmessage({ type: "answer", sessionId: "demo-session", answer: update }));
    expect(viewport.scrollTop).toBe(40);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getAllByRole("heading")[0].textContent).toBe(previewAnswers[0].question);
    act(() => api.channel?.onmessage({ type: "answer", sessionId: "demo-session", answer: { ...update, text: "fixture partial text continued" } }));
    expect(viewport.scrollTop).toBe(40);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "停止生成" }));
    await waitFor(() => expect(api.invoke.mock.calls.some(([name]) => name === "cancel_answer")).toBe(true));
    act(() => api.channel?.onmessage({ type: "sessionStarted", sessionId: "next-session", session: { id: "next-session", title: "next", createdAt: 2, endedAt: null } }));
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
    expect(screen.queryByRole("heading", { name: previewAnswers[0].question })).toBeNull();
    expect(viewport.scrollTop).toBe(800);
  });
});

describe("capture protection preferences",()=>{
 it("defaults to enabled, saves immediately through settings and preserves drafts after errors",async()=>{
   window.history.replaceState({},"","/?page=settings");const user=userEvent.setup();render(<App/>);
   await openService(user,"回答模型");await screen.findByLabelText("模型 API Key");await settingsTab(user,"偏好");
   const toggle=screen.getByRole("switch",{name:"共享时隐藏 Cuvilo"});expect(toggle.getAttribute("aria-checked")).toBe("true");
   await user.click(toggle);expect(toggle.getAttribute("aria-checked")).toBe("false");
   const normal=api.invoke.getMockImplementation()!;
   api.invoke.mockImplementation((name,args)=>name==="save_preferences"?Promise.reject(new Error("fixture protection failed")):normal(name,args));
   await screen.findByText("Error: fixture protection failed");
   expect(toggle.getAttribute("aria-checked")).toBe("false");expect(settings.captureProtection).toBe(true);
   api.invoke.mockImplementation(normal);await user.click(screen.getByRole("button",{name:"重试"}));
   await waitFor(()=>expect(settings.captureProtection).toBe(false));
 });
 it("reports native verification separately from Tencent compatibility and updates recovery choice only",async()=>{
   window.history.replaceState({},"","/?page=settings");const normal=api.invoke.getMockImplementation()!;
   api.invoke.mockImplementation((name,args)=>name==="snapshot"?Promise.resolve({...snapshot(),captureProtection:{requested:true,state:"enabled",windows:{main:17},message:null}}):normal(name,args));
   const user=userEvent.setup();render(<App/>);await openService(user,"回答模型");await screen.findByLabelText("模型 API Key");
   await settingsTab(user,"偏好");expect(screen.queryByText(/腾讯会议兼容性/)).toBeNull();
   await settingsTab(user,"偏好");
   await user.clear(screen.getByLabelText("答案字号"));await user.type(screen.getByLabelText("答案字号"),"22");
   await act(async()=>{api.channel?.onmessage({type:"captureProtectionRecovered",sessionId:"",enabled:false});});
   await settingsTab(user,"偏好");
   expect(screen.getByRole("switch",{name:"共享时隐藏 Cuvilo"}).getAttribute("aria-checked")).toBe("false");
   await settingsTab(user,"偏好");
   expect(screen.getByLabelText("答案字号").getAttribute("value")).toBe("22");
 });
});



describe("native material file drops", () => {
  async function materialsPage() {
    const user=userEvent.setup();render(<App />);await user.click(screen.getByRole("button",{name:"个人材料"}));
    await waitFor(()=>expect(api.dropHandler).not.toBeNull());
    const zone=document.querySelector(".material-drop-zone") as HTMLElement;
    vi.spyOn(zone,"getBoundingClientRect").mockReturnValue({left:160,right:980,top:0,bottom:640,width:820,height:640,x:160,y:0,toJSON(){}});
    return user;
  }
  it("imports an OS file drop into preview once, scales coordinates, and preserves an unconfirmed draft", async () => {
    const normal=api.invoke.getMockImplementation()!;
    let finish!: (value:string)=>void;const extracted=new Promise<string>(resolve=>{finish=resolve;});
    api.invoke.mockImplementation((name,args)=>name==="import_document"?extracted:normal(name,args));
    const user=await materialsPage();vi.stubGlobal("devicePixelRatio",2);
    const event={payload:{type:"drop",paths:["C:/fixture/拖入简历.DOCX"],position:{x:500,y:200}}};
    await act(async()=>{api.dropHandler?.({payload:{...event.payload,type:"enter"}});});expect(screen.getByText("松开以导入文件")).toBeTruthy();
    await act(async()=>{api.dropHandler?.(event);api.dropHandler?.(event);});
    expect(api.invoke.mock.calls.filter(([name])=>name==="import_document")).toHaveLength(1);
    await act(async()=>{finish("fixture extracted text");});const editor=await screen.findByRole("dialog",{name:"确认材料内容"});
    const title=within(editor).getByLabelText("材料标题") as HTMLInputElement;expect(title.value).toBe("拖入简历");expect(document.activeElement).toBe(title);expect(title.selectionStart).toBe(title.value.length);expect(title.selectionEnd).toBe(title.value.length);
    expect((within(editor).getByLabelText("材料内容") as HTMLTextAreaElement).value).toBe("fixture extracted text");
    await act(async()=>{api.dropHandler?.(event);});expect(api.invoke.mock.calls.filter(([name])=>name==="import_document")).toHaveLength(1);
    expect(api.invoke.mock.calls.some(([name])=>name==="save_material")).toBe(false);
    await user.click(within(editor).getByRole("button",{name:"取消"}));await user.click(screen.getByRole("button",{name:"开始面试"}));expect(api.unlistenDrop).toHaveBeenCalledTimes(1);
  });
  it("ignores navigation/outside drops, rejects unsupported files, and clears cancelled hover", async () => {
    await materialsPage();
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["C:/fixture/resume.txt"],position:{x:20,y:100}}});});
    expect(api.invoke.mock.calls.some(([name])=>name==="import_document")).toBe(false);
    await act(async()=>{api.dropHandler?.({payload:{type:"enter",paths:["C:/fixture/resume.txt"],position:{x:200,y:100}}});});expect(screen.getByText("松开以导入文件")).toBeTruthy();
    await act(async()=>{api.dropHandler?.({payload:{type:"leave"}});});expect(screen.queryByText("松开以导入文件")).toBeNull();
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["C:/fixture/file.exe"],position:{x:200,y:100}}});});await screen.findByText("支持 PDF、DOCX、TXT 和 Markdown 文件。");
    expect(api.invoke.mock.calls.some(([name])=>name==="import_document")).toBe(false);
  });
  it("accepts multiple dropped files in one editable confirmation, retries failed saves, and restores focus", async () => {
    const normal=api.invoke.getMockImplementation()!;
    let records: Snapshot["materials"]=[], fail=true;
    api.invoke.mockImplementation(async (name,args)=>{
      if(name === "import_document") return "fixture batch content";
      if(name === "snapshot") return {...snapshot(),materials:[...records]};
      if(name === "save_material") {
        if(args.material.title === "b" && fail) {fail=false;throw new Error("fixture save failure");}
        records.push(args.material);return;
      }
      return normal(name,args);
    });
    const user=await materialsPage();const trigger=screen.getByRole("button",{name:"导入文件"});trigger.focus();
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["a.txt","b.md"],position:{x:200,y:100}}});});
    const dialog=await screen.findByRole("dialog",{name:"导入材料"});
    await within(dialog).findByRole("button",{name:"确认导入（2）"});
    expect(api.invoke.mock.calls.some(([name])=>name==="save_material")).toBe(false);
    await user.clear(within(dialog).getByLabelText("材料标题"));await user.type(within(dialog).getByLabelText("材料标题"),"edited a");
    await user.click(within(dialog).getByRole("button",{name:/b\.md.*待确认/}));
    expect((within(dialog).getByLabelText("材料标题") as HTMLInputElement).value).toBe("b");
    await user.click(within(dialog).getByRole("button",{name:"确认导入（2）"}));
    await within(dialog).findByText(/fixture save failure/);
    expect(records).toHaveLength(1);expect(records[0].title).toBe("edited a");
    expect(within(dialog).getByRole("status").textContent).toContain("已导入 1 份");
    expect(document.querySelector(".toast-surface[data-kind=error]")).toBeNull();
    await user.click(within(dialog).getByRole("button",{name:"确认导入（1）"}));
    await waitFor(()=>expect(screen.queryByRole("dialog",{name:"导入材料"})).toBeNull());
    expect(api.invoke.mock.calls.filter(([name])=>name==="save_material")).toHaveLength(3);
    expect(document.activeElement).toBe(trigger);expect(records).toHaveLength(2);
    expect(screen.getByRole("button",{name:"全部"}).getAttribute("aria-pressed")).toBe("true");
  });
  it("supports multi-select from the picker and cancels a batch without writing materials", async () => {
    const dialogs=await import("@tauri-apps/plugin-dialog");vi.mocked(dialogs.open).mockResolvedValueOnce(["a.txt","b.md"]);
    const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name === "import_document"?Promise.resolve("fixture text"):normal(name,args));
    const user=await materialsPage();const trigger=screen.getByRole("button",{name:"导入文件"});await user.click(trigger);
    const dialog=await screen.findByRole("dialog",{name:"导入材料"});await within(dialog).findByRole("button",{name:"确认导入（2）"});
    expect(dialogs.open).toHaveBeenLastCalledWith(expect.objectContaining({multiple:true}));
    await user.keyboard("{Escape}");await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);expect(api.invoke.mock.calls.some(([name])=>name==="save_material")).toBe(false);
  });
  it("filters enabled materials and distinguishes filtered emptiness from no materials", async () => {
    initialSnapshot=Promise.resolve({...snapshot(),materials:[{id:"off",title:"fixture off",text:"fixture content",kind:"project",enabled:false,updatedAt:1}]});
    const user=await materialsPage();await user.click(screen.getByRole("button",{name:"已启用"}));await screen.findByRole("heading",{name:"暂无启用材料"});
    expect(screen.queryByRole("region",{name:"导入材料"})).toBeNull();expect(screen.getByRole("textbox",{name:"搜索材料"})).toBeTruthy();
    await user.click(screen.getByRole("button",{name:"全部"}));await screen.findByRole("heading",{name:"fixture off"});
  });
  it("cleans up a late native listener when the materials module has already unmounted", async () => {
    let finish!: (stop:()=>void)=>void;api.onDragDropEvent.mockImplementationOnce(handler=>{api.dropHandler=handler;return new Promise(resolve=>{finish=resolve;});});
    const user=await materialsPage();await user.click(screen.getByRole("button",{name:"开始面试"}));await act(async()=>{finish(api.unlistenDrop);});expect(api.unlistenDrop).toHaveBeenCalledTimes(1);
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["C:/fixture/resume.txt"],position:{x:200,y:100}}});});expect(api.invoke.mock.calls.some(([name])=>name==="import_document")).toBe(false);
  });
  it("opens one batch from the home material popup and returns to the original entry on cancel", async () => {
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="import_document"?Promise.resolve("fixture multi popup text"):normal(name,args));
    const user=userEvent.setup();render(<App/>);const trigger=await screen.findByRole("button",{name:"查看启用材料"});await user.click(trigger);
    await waitFor(()=>expect(api.dropHandler).not.toBeNull());
    const zone=document.querySelector(".material-drop-zone") as HTMLElement;vi.spyOn(zone,"getBoundingClientRect").mockReturnValue({left:200,right:800,top:100,bottom:500,width:600,height:400,x:200,y:100,toJSON(){}});
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["C:/fixture/one.md","C:/fixture/two.txt"],position:{x:250,y:200}}});});
    const dialog=await screen.findByRole("dialog",{name:"导入材料"});await within(dialog).findByRole("button",{name:"确认导入（2）"});
    expect(screen.getAllByRole("dialog")).toHaveLength(1);expect(screen.queryByRole("dialog",{name:"个人材料"})).toBeNull();
    await user.click(within(dialog).getByRole("button",{name:"取消"}));expect(document.activeElement).toBe(trigger);
    expect(api.invoke.mock.calls.some(([name])=>name==="save_material")).toBe(false);
  });
  it("closes the material popup before previewing a dropped file and restores its trigger on cancel", async () => {
    const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="import_document"?Promise.resolve("fixture popup text"):normal(name,args));
    const user=userEvent.setup();render(<App/>);const trigger=await screen.findByRole("button",{name:"查看启用材料"});await user.click(trigger);await waitFor(()=>expect(api.dropHandler).not.toBeNull());
    const zone=document.querySelector(".material-drop-zone") as HTMLElement;vi.spyOn(zone,"getBoundingClientRect").mockReturnValue({left:200,right:800,top:100,bottom:500,width:600,height:400,x:200,y:100,toJSON(){}});
    await act(async()=>{api.dropHandler?.({payload:{type:"drop",paths:["C:/fixture/popup.md"],position:{x:250,y:200}}});});const editor=await screen.findByRole("dialog",{name:"确认材料内容"});expect(screen.queryByRole("dialog",{name:"个人材料"})).toBeNull();
    await user.click(within(editor).getByRole("button",{name:"取消"}));expect(document.activeElement).toBe(trigger);
  });
});

describe("interview review workflow", () => {
  const ended = { id: "review-session", title: "fixture completed interview", createdAt: 1, endedAt: 120001 };
  it("loads the latest completed review with paired questions, answers and cleaned full transcription", async () => {
    initialSnapshot = Promise.resolve({ ...snapshot(), sessions: [ended] });
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail" ? Promise.resolve({answers:previewAnswers.map((answer,index)=>index===0?{...answer,status:"generating",text:""}:{...answer}),transcripts:[{...previewTranscripts[0],text:"？完整对话"}]}) : normal(name,args));
    const user=userEvent.setup();render(<App />);
    await screen.findByText(ended.title);
    expect(screen.queryByRole("tab",{name:/问答/})).toBeNull();
    await user.click(screen.getByRole("button",{name:"继续复盘"}));
    expect(screen.getByRole("tab",{name:/问答/})).toBeTruthy();
    expect(screen.getByRole("heading",{name:previewAnswers[0].question})).toBeTruthy();
    expect(screen.getByText("未生成参考答案")).toBeTruthy();
    expect(screen.queryByText("正在整理回答…")).toBeNull();
    expect(document.querySelector(".review-workspace .stream-caret")).toBeNull();
    expect(screen.queryByRole("button",{name:"结束面试"})).toBeNull();
    await user.click(screen.getByRole("tab",{name:/完整转写/}));
    expect(screen.getByText("完整对话")).toBeTruthy();expect(screen.queryByText("？完整对话")).toBeNull();
  });
  it("shows the three newest completed interviews and reads the selected record", async () => {
    const sessions=[
      {...ended,id:"older",title:"older saved interview",createdAt:300},
      {...ended,id:"active",title:"active interview",createdAt:1000,endedAt:null},
      {...ended,id:"latest",title:"newest saved interview",createdAt:500},
      {...ended,id:"oldest",title:"outside the recent three",createdAt:100},
      {...ended,id:"middle",title:"middle saved interview",createdAt:400},
    ];
    initialSnapshot=Promise.resolve({...snapshot(),sessions});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?Promise.resolve({answers:[{...previewAnswers[0],question:`question from ${args.id}`}],transcripts:[]}):normal(name,args));
    const user=userEvent.setup();render(<App />);
    const recent=await screen.findByRole("region",{name:"最近面试"});
    await within(recent).findByText("newest saved interview");
    expect(within(recent).queryByText("active interview")).toBeNull();
    expect(within(recent).queryByText("outside the recent three")).toBeNull();
    expect([...recent.querySelectorAll(".recent-review-row")].map(row=>row.textContent)).toEqual([
      expect.stringContaining("newest saved interview"),expect.stringContaining("middle saved interview"),expect.stringContaining("older saved interview"),
    ]);
    await user.click(within(recent).getByRole("button",{name:"查看复盘：middle saved interview"}));
    await screen.findByRole("heading",{name:"question from middle"});
    expect(screen.getByRole("heading",{name:"middle saved interview",level:1})).toBeTruthy();
    await user.click(screen.getByRole("button",{name:"返回面试"}));
    await user.click(screen.getByRole("button",{name:"继续复盘"}));
    await screen.findByRole("heading",{name:"question from latest"});
    expect(screen.getByRole("heading",{name:"newest saved interview",level:1})).toBeTruthy();
  });
  it("opens only sound controls and keeps the home draft on Escape", async () => {
    const user=userEvent.setup();render(<App />);
    await user.click(screen.getByRole("button",{name:"本次面试选项"}));await user.type(screen.getByLabelText("会话名称"),"draft interview");await user.keyboard("{Escape}");
    const trigger=await screen.findByRole("button",{name:"调整会议音源"});await user.click(trigger);
    const dialog=screen.getByRole("dialog",{name:"会议声音"});
    expect(within(dialog).getByLabelText("会议音源")).toBeTruthy();
    expect(within(dialog).queryByLabelText("会话名称")).toBeNull();
    expect(within(dialog).queryByText("语音识别")).toBeNull();expect(within(dialog).queryByText("个人材料")).toBeNull();
    expect(within(dialog).queryByRole("switch",{name:"转写我的回答"})).toBeNull();
    await user.keyboard("{Escape}");expect(document.activeElement).toBe(trigger);
    await user.click(screen.getByRole("button",{name:"本次面试选项"}));expect((screen.getByLabelText("会话名称") as HTMLInputElement).value).toBe("draft interview");await user.keyboard("{Escape}");
    expect(screen.queryByRole("button",{name:"会前设置"})).toBeNull();
    expect(api.invoke.mock.calls.some(([name])=>name==="start_session")).toBe(false);
  });
  it("uses the material-only dialog to toggle existing materials and open management", async () => {
    let materials=[{id:"m1",title:"fixture resume",kind:"resume",text:"fixture",enabled:true,updatedAt:1},{id:"m2",title:"fixture project",kind:"project",text:"fixture",enabled:false,updatedAt:1}];
    initialSnapshot=Promise.resolve({...snapshot(),materials});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async (name,args)=>{
      if(name==="save_material"){materials=materials.map(item=>item.id===args.material.id?args.material:item);initialSnapshot=Promise.resolve({...snapshot(),materials});return;}
      return normal(name,args);
    });
    const user=userEvent.setup();render(<App />);const trigger=await screen.findByRole("button",{name:"查看启用材料"});await user.click(trigger);
    const dialog=screen.getByRole("dialog",{name:"个人材料"});
    expect(within(dialog).queryByLabelText("会议音源")).toBeNull();expect(within(dialog).queryByText("回答模型")).toBeNull();
    await user.click(within(dialog).getByRole("switch",{name:"用于回答：fixture project"}));
    await waitFor(()=>expect(within(dialog).getByRole("switch",{name:"用于回答：fixture project"}).getAttribute("aria-checked")).toBe("true"));
    expect(api.invoke.mock.calls.find(([name])=>name==="save_material")?.[1].material).toEqual({...materials[1],enabled:true});
    expect(screen.queryByText("材料已加入回答上下文")).toBeNull();
    await user.keyboard("{Escape}");expect(document.activeElement).toBe(trigger);expect(trigger.textContent).toContain("2 份已启用");
    await user.click(trigger);await user.click(screen.getByRole("button",{name:"管理材料"}));await screen.findByRole("heading",{name:"个人材料",level:1});expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("imports from the material-only dialog through the existing preview confirmation", async () => {
    const dialogs=await import("@tauri-apps/plugin-dialog");vi.mocked(dialogs.open).mockResolvedValueOnce("C:/fixture/resume.txt");
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="import_document"?Promise.resolve("fixture imported text"):normal(name,args));
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"查看启用材料"}));
    await user.click(screen.getByRole("button",{name:"导入材料"}));
    const editor=await screen.findByRole("dialog",{name:"确认材料内容"});
    expect(screen.queryByRole("dialog",{name:"个人材料"})).toBeNull();
    expect((within(editor).getByLabelText("材料内容") as HTMLTextAreaElement).value).toBe("fixture imported text");
    expect(api.invoke.mock.calls.some(([name])=>name==="save_material")).toBe(false);
    await user.keyboard("{Escape}");await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button",{name:"查看启用材料"}));
  });
  it("opens the exact service dialog from missing setup without leaving home", async () => {
    initialSnapshot=Promise.resolve({...snapshot(),configured:[]});
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"连接模型"}));
    expect(await screen.findByRole("dialog",{name:"回答模型"})).toBeTruthy();expect(document.querySelector(".preparation-setup")).toBeTruthy();expect(screen.queryByRole("tab",{name:"服务"})).toBeNull();
  });
  it("opens only the first answer, supports bulk disclosure, and returns to preparation", async () => {
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[ended]});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?Promise.resolve({answers:structuredClone(previewAnswers),transcripts:[]}):normal(name,args));
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"继续复盘"}));
    const first=within(screen.getByRole("heading",{name:previewAnswers[0].question})).getByRole("button");
    const second=within(screen.getByRole("heading",{name:previewAnswers[1].question})).getByRole("button");
    expect(first.getAttribute("aria-expanded")).toBe("true");expect(second.getAttribute("aria-expanded")).toBe("false");
    await user.click(second);expect(second.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button",{name:"复盘操作"}));await user.click(screen.getByRole("menuitem",{name:"收起全部答案"}));
    expect(first.getAttribute("aria-expanded")).toBe("false");expect(second.getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button",{name:"复盘操作"}));await user.click(screen.getByRole("menuitem",{name:"展开全部答案"}));
    expect(first.getAttribute("aria-expanded")).toBe("true");expect(second.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button",{name:"返回面试"}));expect(screen.getByRole("region",{name:"会前准备"})).toBeTruthy();
    expect(screen.queryByRole("tab",{name:/问答/})).toBeNull();
  });
  it("locates a closed question, keeps disclosure on refresh and resets for another interview", async () => {
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[ended]});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?Promise.resolve({answers:structuredClone(previewAnswers),transcripts:[]}):normal(name,args));
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"继续复盘"}));
    await user.click(screen.getByRole("button",{name:"复盘操作"}));await user.click(screen.getByRole("menuitem",{name:"问题目录"}));
    const dialog=screen.getByRole("dialog",{name:"问题目录"});
    await user.click(within(dialog).getByRole("button",{name:new RegExp(previewAnswers[1].question.replace(/[？?]/g,"."))}));
    expect(screen.queryByRole("dialog")).toBeNull();expect(document.activeElement).toBe(screen.getByRole("button",{name:"复盘操作"}));
    expect(within(screen.getByRole("heading",{name:previewAnswers[1].question})).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    await act(async()=>{api.channel?.onmessage({type:"historyChanged",sessionId:""});});
    expect(within(screen.getByRole("heading",{name:previewAnswers[1].question})).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    const next={...ended,id:"another-review",title:"another completed interview"};
    await act(async()=>{api.channel?.onmessage({type:"reviewRequested",sessionId:next.id,session:next});});
    await screen.findByRole("heading",{name:next.title});
    expect(within(screen.getByRole("heading",{name:previewAnswers[1].question})).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
  it("opens this interview's review after End even when the main window was on settings", async () => {
    window.history.replaceState({},"","/?page=settings");
    const active={...ended,endedAt:null};
    initialSnapshot=Promise.resolve({...snapshot(),session:active});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?Promise.resolve({answers:structuredClone(previewAnswers),transcripts:[]}):normal(name,args));
    render(<App />);await screen.findByRole("button",{name:"配置回答模型"});
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[ended]});
    await act(async()=>{api.channel?.onmessage({type:"sessionStopped",sessionId:ended.id,session:ended});api.channel?.onmessage({type:"reviewRequested",sessionId:ended.id,session:ended});});
    await screen.findByRole("heading",{name:ended.title});
    expect(screen.getByRole("heading",{name:ended.title,level:1})).toBeTruthy();
    expect(screen.getByRole("heading",{name:previewAnswers[0].question})).toBeTruthy();
  });
  it("does not let a late previous-review response replace the just-finished interview", async () => {
    const old={...ended,id:"old",title:"older interview"};
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[old]});
    let complete!: (value: {answers: typeof previewAnswers;transcripts: typeof previewTranscripts})=>void;
    const pending=new Promise<{answers: typeof previewAnswers;transcripts: typeof previewTranscripts}>(resolve=>{complete=resolve;});
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?(args.id==="old"?pending:Promise.resolve({answers:structuredClone(previewAnswers),transcripts:[]})):normal(name,args));
    render(<App />);
    await waitFor(()=>expect(api.invoke.mock.calls.some(([name,args])=>name==="session_detail"&&args.id==="old")).toBe(true));
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[ended,old]});
    await act(async()=>{api.channel?.onmessage({type:"reviewRequested",sessionId:ended.id,session:ended});});
    await screen.findByRole("heading",{name:ended.title});
    await act(async()=>{complete({answers:[],transcripts:[]});});
    expect(screen.getByRole("heading",{name:ended.title})).toBeTruthy();
    expect(screen.getByRole("heading",{name:previewAnswers[0].question})).toBeTruthy();
  });
  it("keeps an empty just-ended review distinct from older saved interviews", async () => {
    const normal=api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?Promise.resolve({answers:[],transcripts:[]}):normal(name,args));
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[{...ended,id:"old",title:"older interview"}]});
    render(<App />);await screen.findByText("older interview");
    await act(async()=>{api.channel?.onmessage({type:"reviewRequested",sessionId:ended.id,session:ended});});
    await screen.findByRole("heading",{name:ended.title});
    expect(screen.getByRole("heading",{name:"本场暂无参考答案"})).toBeTruthy();
    expect(screen.queryByText("本场没有问答或转写，未存入历史记录。")).toBeNull();
    expect(screen.queryByRole("heading",{name:"older interview"})).toBeNull();
  });
  it("allows retrying failed review reads and keeps End enabled after a failed stop", async () => {
    initialSnapshot=Promise.resolve({...snapshot(),sessions:[ended]});
    const normal=api.invoke.getMockImplementation()!;let fail=true;
    api.invoke.mockImplementation((name,args)=>name==="session_detail"?(fail?Promise.reject(new Error("fixture review failure")):Promise.resolve({answers:[],transcripts:[]})):normal(name,args));
    const user=userEvent.setup();render(<App />);await user.click(await screen.findByRole("button",{name:"继续复盘"}));await screen.findByText("Error: fixture review failure");
    fail=false;await user.click(screen.getByRole("button",{name:"重试读取"}));await screen.findByRole("heading",{name:ended.title});
    initialSnapshot=Promise.resolve(snapshot());
    await act(async()=>{api.channel?.onmessage({type:"historyChanged",sessionId:""});});
    await waitFor(()=>expect(screen.queryByRole("heading",{name:ended.title})).toBeNull());
    cleanup();window.history.replaceState({},"","/?window=answer");
    initialSnapshot=Promise.resolve({...snapshot(),session:{...ended,endedAt:null}});
    api.invoke.mockImplementation((name,args)=>name==="stop_session"?Promise.reject(new Error("fixture end failure")):normal(name,args));
    render(<App />);const end=await screen.findByRole("button",{name:"结束"});await user.click(end);
    await screen.findByText("Error: fixture end failure");expect(end.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button",{name:"立即回答"})).toBeTruthy();
  });
});


describe("screen questions",()=>{
 const session={id:"demo-session",title:"screen fixture",createdAt:1,endedAt:null};
 const capture=(stage:"ready"|"recognizing"|"error"="ready")=>({version:5,jobId:"screen-job",sessionId:session.id,stage,text:"if (a <= b) {\n  item_count++;\n}",error:"",questionId:""});
 function prepare(extra:Partial<Snapshot>={}){window.history.replaceState({},"","/?window=answer");initialSnapshot=Promise.resolve({...snapshot(),session,...extra});}
 it("starts capture from the existing More menu without submitting a voice question",async()=>{
  prepare();const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"更多"}));await user.click(screen.getByRole("menuitem",{name:/截图提问/}));
  await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="begin_screen_capture")).toBe(true));expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(false);
 });
 it("keeps OCR code editable and retries a failed submission in place",async()=>{
  prepare({screenCapture:capture()});let reject=true;const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="submit_screen_question"&&reject?Promise.reject(new Error("fixture submit failed")):normal(name,args));
  const user=userEvent.setup();render(<App/>);const input=await screen.findByRole("textbox",{name:"识别出的题目"});expect((input as HTMLTextAreaElement).value).toBe(capture().text);
  const corrected="if (a >= b) {\n  item_count += 2;\n}";fireEvent.change(input,{target:{value:corrected}});await user.click(screen.getByRole("button",{name:"回答此题"}));await screen.findByText(/fixture submit failed/);expect((input as HTMLTextAreaElement).value).toBe(corrected);
  reject=false;await user.click(screen.getByRole("button",{name:"回答此题"}));await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="submit_screen_question")).toHaveLength(2));expect(api.invoke.mock.calls.filter(([name])=>name==="submit_screen_question").at(-1)?.[1]).toEqual({jobId:"screen-job",text:corrected});
 });
 it("does not submit empty OCR and uses the existing toolbar to cancel recognition",async()=>{
  prepare({screenCapture:{...capture(),text:""}});const user=userEvent.setup();render(<App/>);await screen.findByRole("textbox",{name:"识别出的题目"});expect((screen.getByRole("button",{name:"回答此题"}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>api.channel?.onmessage({type:"screenCapture",sessionId:session.id,screenCapture:{...capture("recognizing"),version:6}}));await user.click(screen.getByRole("button",{name:"取消识别"}));await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="cancel_screen_capture")).toBe(true));expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(false);
 });
 it("ignores stale and other-session OCR events and clears the editor when a session ends",async()=>{
  prepare({screenCapture:capture()});render(<App/>);const input=await screen.findByRole("textbox",{name:"识别出的题目"});
  await act(async()=>{api.channel?.onmessage({type:"screenCapture",sessionId:session.id,screenCapture:{...capture(),version:4,text:"stale"}});api.channel?.onmessage({type:"screenCapture",sessionId:"other",screenCapture:{...capture(),version:9,text:"other"}});});expect((input as HTMLTextAreaElement).value).toBe(capture().text);
  initialSnapshot=Promise.resolve(snapshot());await act(async()=>api.channel?.onmessage({type:"sessionStopped",sessionId:session.id}));await waitFor(()=>expect(screen.queryByRole("textbox",{name:"识别出的题目"})).toBeNull());
 });
 it("corrects a screen question as a revision and preserves the dialog draft on failure",async()=>{
  prepare({answers:[{...previewAnswers[0],mode:"screen"}]});let reject=true;const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="correct_screen_question"&&reject?Promise.reject(new Error("fixture correction failed")):normal(name,args));
  const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"修正题目"}));const input=screen.getByRole("textbox",{name:"题目内容"});fireEvent.change(input,{target:{value:"修正后的题目\n1 <= 2"}});await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"重新回答"}));await screen.findByText(/fixture correction failed/);expect((input as HTMLTextAreaElement).value).toBe("修正后的题目\n1 <= 2");
  reject=false;await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"重新回答"}));await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(api.invoke.mock.calls.filter(([name])=>name==="correct_screen_question").at(-1)?.[1]).toEqual({questionId:previewAnswers[0].questionId,text:"修正后的题目\n1 <= 2"});
 });
 it("requests original pixels only on demand and releases the view on another capture",async()=>{
  prepare({answers:[{...previewAnswers[0],mode:"screen"}],screenCapture:{...capture(),stage:"answered",questionId:previewAnswers[0].questionId}});const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="screen_capture_image"?Promise.resolve("data:image/bmp;base64,Qk0="):normal(name,args));
  const user=userEvent.setup();render(<App/>);await screen.findByRole("button",{name:"查看原截图"});expect(api.invoke.mock.calls.some(([name])=>name==="screen_capture_image")).toBe(false);await user.click(screen.getByRole("button",{name:"查看原截图"}));await screen.findByAltText("本次框选的题目原图");
  await act(async()=>api.channel?.onmessage({type:"screenCapture",sessionId:session.id,screenCapture:{...capture("recognizing"),version:6,jobId:"next"}}));await waitFor(()=>expect(screen.queryByAltText("本次框选的题目原图")).toBeNull());
 });
 it("does not reopen an image after its capture has expired",async()=>{
  prepare({answers:[{...previewAnswers[0],mode:"screen"}],screenCapture:{...capture(),stage:"answered",questionId:previewAnswers[0].questionId}});let resolve!:(value:string)=>void;const image=new Promise<string>(done=>resolve=done);const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="screen_capture_image"?image:normal(name,args));
  const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"查看原截图"}));await act(async()=>api.channel?.onmessage({type:"screenCapture",sessionId:session.id,screenCapture:{...capture("recognizing"),version:6,jobId:"next"}}));await act(async()=>resolve("data:image/bmp;base64,Qk0="));expect(screen.queryByRole("dialog")).toBeNull();
 });
 it("saves capture preferences with other drafts and supports disabled and reset shortcuts",async()=>{
  const user=await settingsPage();await settingsTab(user,"偏好");await user.click(screen.getByRole("switch",{name:"截图后确认题目"}));expect(screen.queryByRole("switch",{name:"Shift＋鼠标双击框选"})).toBeNull();await settingsTab(user,"快捷键");await user.click(screen.getByRole("button",{name:"停用停止生成快捷键"}));expect((screen.getByLabelText("停止生成") as HTMLInputElement).value).toBe("");await user.click(screen.getByRole("button",{name:"恢复默认快捷键"}));expect((screen.getByLabelText("立即回答") as HTMLInputElement).value).toBe("Ctrl+Enter");await user.click(screen.getByRole("button",{name:"停用停止生成快捷键"}));await waitFor(()=>expect(settings.screenCapture).toEqual({confirmBeforeAnswer:true,shiftDoubleClick:false}));await waitFor(()=>expect(settings.shortcuts.cancel).toBe(""));expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
 });
});


describe("shortcut default identity",()=>{
 it("does not mark an unchanged default preset dirty because native JSON keys use a different order",async()=>{
  settings.shortcuts={screen:"Ctrl+Shift+S",manual:"Ctrl+Shift+M",answer:"Ctrl+Enter",cancel:"Ctrl+Shift+X",toggle:"Ctrl+Shift+H"};
  const user=await settingsPage();await settingsTab(user,"快捷键");await user.click(screen.getByRole("button",{name:"恢复默认快捷键"}));
  expect(screen.queryByRole("button",{name:"保存"})).toBeNull();expect(api.invoke.mock.calls.some(([name])=>name==="save_preferences")).toBe(false);
  expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
});


describe("minimal answer window input", () => {
  const session = { id: "demo-session", title: "input fixture", createdAt: 1, endedAt: null };
  function prepare(extra: Partial<Snapshot> = {}) {
    window.history.replaceState({}, "", "/?window=answer");
    initialSnapshot = Promise.resolve({ ...snapshot(), session, ...extra });
  }
  async function openManual(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitem", { name: "手动提问" }));
    const input = await screen.findByRole("textbox", { name: "手动输入问题" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    return input as HTMLTextAreaElement;
  }
  it("removes the visible answer title and empty recognition notice while retaining recovery actions", async () => {
    prepare({ screenCapture: { version: 1, jobId: "empty", sessionId: session.id, stage: "error", text: "", error: "未识别出文字，请重新框选或手动输入题目", questionId: "" } });
    render(<App />);
    await screen.findByRole("textbox", { name: "识别出的题目" });
    expect(screen.queryByText("实时答案")).toBeNull();
    expect(screen.queryByText("未识别出文字，请重新框选或手动输入题目")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "重新框选" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "回答此题" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps genuine recognition failures visible", async () => {
    prepare({ screenCapture: { version: 1, jobId: "failure", sessionId: session.id, stage: "error", text: "", error: "本地识别超时，请缩小选区后重试", questionId: "" } });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe("本地识别超时，请缩小选区后重试");
  });
  it("keeps the draft after outside dismissal and Escape, and resets the open input on a new session", async () => {
    prepare(); const user = userEvent.setup(); render(<App />);
    const input = await openManual(user);
    const dialog = screen.getByRole("dialog", { name: "手动输入问题" });
    expect(dialog.classList.contains("answer-manual-input")).toBe(true);
    expect(dialog.querySelector('[data-slot="dialog-close"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(within(dialog).getByRole("heading").classList.contains("sr-only")).toBe(true);
    await user.type(input, "保留这段未提交草稿");
    await user.click(screen.getByRole("log", { name: "问题与答案" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await openManual(user)).value).toBe("保留这段未提交草稿");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多" }));
    await openManual(user);
    await act(async () => api.channel?.onmessage({ type: "sessionStarted", sessionId: "next-session", session: { ...session, id: "next-session" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps manual input open after pointer movement and incidental focus changes", async () => {
    prepare(); const user=userEvent.setup();render(<App />);const input=await openManual(user);
    await user.type(input,"draft stays");fireEvent.pointerMove(document.body,{clientX:10,clientY:70});
    act(()=>screen.getByRole("button",{name:"更多"}).focus());
    expect(screen.getByRole("textbox",{name:"手动输入问题"})).toBe(input);expect(input.value).toBe("draft stays");
    await user.click(screen.getByRole("log",{name:"问题与答案"}));await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("allows an outside toolbar action on the first click", async () => {
    prepare(); const user = userEvent.setup(); render(<App />);
    await openManual(user);
    const pin = screen.getByRole("button", { name: /^(取消置顶|置顶窗口)$/ });
    await user.click(pin);
    await waitFor(() => expect(api.setAlwaysOnTop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps multiline keyboard submission and retains the draft when the request fails", async () => {
    prepare(); const normal = api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((name, args) => name === "request_answer" ? Promise.reject(new Error("fixture manual request failed")) : normal(name, args));
    const user = userEvent.setup(); render(<App />);
    const input = await openManual(user);
    await user.type(input, "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(input.value).toBe("第一行\n第二行");
    expect(api.invoke.mock.calls.some(([name]) => name === "request_answer")).toBe(false);
    await user.keyboard("{Enter}");
    await screen.findByText(/fixture manual request failed/);
    expect(input.value).toBe("第一行\n第二行");
    expect(api.invoke.mock.calls.filter(([name]) => name === "request_answer")).toHaveLength(1);
    expect(api.invoke.mock.calls.find(([name]) => name === "request_answer")?.[1]).toEqual({ text: "第一行\n第二行", questionId: null, mode: "short" });
  });
});


describe("minimal settings services",()=>{
 it("adds independent model and speech providers, tests their draft credentials, and saves existing keys intact",async()=>{
  const user=await settingsPage();
  await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));
  await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"通义千问"}));
  await user.click(screen.getByLabelText("模型 API Key"));await user.paste("qwen-fixture-key");
  await user.click(within(modelCard()).getByRole("button",{name:"检测"}));
  await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="test_provider").at(-1)?.[1].provider.kind).toBe("llm"));
  await user.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("设置已保存");
  await openService(user,"语音识别");await user.click(screen.getByRole("button",{name:"添加语音识别服务"}));
  await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"阿里云 Paraformer"}));
  expect(screen.queryByLabelText("App ID")).toBeNull();
  await user.click(screen.getByLabelText("语音 API Key"));await user.paste("asr-fixture-key");
  await user.click(screen.getByRole("button",{name:"检测"}));
  await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="test_provider").at(-1)?.[1].provider.kind).toBe("dashscope"));
  await user.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("设置已保存");
  expect(settings.providers.find(p=>p.id===settings.activeModel)?.name).toBe("通义千问");
  expect(settings.providers.find(p=>p.id===settings.asrProvider)?.kind).toBe("dashscope");
  expect(settings.activeModel).not.toBe(settings.asrProvider);expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
  expect(secrets[settings.activeModel].apiKey).toBe("qwen-fixture-key");expect(secrets[settings.asrProvider].apiKey).toBe("asr-fixture-key");
 });
 it("keeps local OCR as default and can configure, test, and save a separate vision OCR service",async()=>{
  const user=await settingsPage();await openService(user,"截图识别");
  expect(screen.getByRole("combobox",{name:"OCR 服务"}).textContent).toContain("Windows OCR");
  await user.click(screen.getByRole("button",{name:"添加截图识别服务"}));
  await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"通义千问视觉"}));
  expect(screen.queryByText("截图将发送至此服务。")).toBeNull();
  await user.type(screen.getByLabelText("OCR API Key"),"ocr-fixture-key");
  await user.click(screen.getByRole("button",{name:"检测"}));
  await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="test_provider").at(-1)?.[1].provider.kind).toBe("ocr"));
  await user.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("设置已保存");
  expect(settings.providers.find(p=>p.id===settings.ocrProvider)?.kind).toBe("ocr");expect(settings.activeModel).toBe("deepseek");expect(settings.asrProvider).toBe("xfyun");
  expect(secrets[settings.ocrProvider!].apiKey).toBe("ocr-fixture-key");
  await user.click(screen.getByRole("combobox",{name:"OCR 服务"}));await user.click(screen.getByRole("option",{name:"本地 · Windows OCR"}));
  expect(screen.queryByLabelText("OCR API Key")).toBeNull();
 });
 it("keeps five short categories and removes the gesture and explanatory blocks",async()=>{
  const user=await settingsPage();await closeService(user);expect(screen.getAllByRole("tab").map(el=>el.textContent)).toEqual(["服务","偏好","快捷键","数据","关于"]);
  await settingsTab(user,"偏好");
  expect(screen.queryByText(/Shift.*双击/)).toBeNull();expect(document.querySelector(".settings-section-heading p")).toBeNull();
  expect(screen.queryByText(/稳定转写到达/)).toBeNull();expect(screen.queryByLabelText("答案阅读预览")).toBeNull();
  await settingsTab(user,"服务");await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();await closeService(user);expect(settings.providers).toHaveLength(2);
 });
});


describe("service management and automatic preferences",()=>{
 it("selects an existing vendor instead of creating a duplicate",async()=>{
  const user=await settingsPage();const original=settings.providers.length;
  await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:/DeepSeek/}));
  await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));expect(screen.getAllByRole("option")).toHaveLength(1);await user.keyboard("{Escape}");
  expect(settings.providers).toHaveLength(original);expect((screen.getByRole("button",{name:"保存"}) as HTMLButtonElement).disabled).toBe(true);
 });
 it("deletes a saved service and its credential with confirmation and restores focus",async()=>{
  const user=await settingsPage();await user.click(screen.getByRole("button",{name:"删除服务"}));
  expect(api.invoke.mock.calls.some(([name])=>name==="remove_provider")).toBe(false);
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button",{name:"删除"}));
  await waitFor(()=>expect(settings.activeModel).toBe(""));expect(secrets.deepseek).toBeUndefined();
  await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());expect(document.activeElement).toBe(screen.getByRole("button",{name:"添加回答模型服务"}));
 });
 it("keeps a failed deletion open and retains the service and draft key",async()=>{
  const user=await settingsPage();await user.type(screen.getByLabelText("模型 API Key"),"-draft");const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="remove_provider"?Promise.reject(new Error("fixture remove failed")):normal(name,args));
  await user.click(screen.getByRole("button",{name:"删除服务"}));await user.click(within(screen.getByRole("alertdialog")).getByRole("button",{name:"删除"}));
  await screen.findByText(/fixture remove failed/);expect(settings.activeModel).toBe("deepseek");
  expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("saved-fixture-model-key-draft");
 });
 it("autosaves opacity and shortcuts without committing a dirty service or key",async()=>{
  const user=await settingsPage();await user.type(screen.getByLabelText("模型 API Key"),"-unsaved");await settingsTab(user,"偏好");
  expect(screen.queryByRole("button",{name:"保存"})).toBeNull();fireEvent.change(screen.getByRole("slider",{name:"背景透明度"}),{target:{value:"25"}});
  await waitFor(()=>expect(settings.answerOpacity).toBe(75));expect(screen.queryByText("已保存",{exact:true})).toBeNull();expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
  expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
  await settingsTab(user,"快捷键");await user.click(screen.getByRole("button",{name:"恢复默认快捷键"}));
  await waitFor(()=>expect(settings.shortcuts.toggle).toBe("Ctrl+Shift+H"));
  await settingsTab(user,"服务");expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("saved-fixture-model-key-unsaved");
  await user.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("设置已保存");expect(settings.answerOpacity).toBe(75);expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key-unsaved");
 });
 it("autosaves silently and keeps only failure feedback and retry",async()=>{
  const user=await settingsPage();await settingsTab(user,"偏好");const normal=api.invoke.getMockImplementation()!;let rejectSave!:(error:Error)=>void;
  api.invoke.mockImplementation((name,args)=>name==="save_preferences"?new Promise<void>((_,reject)=>{rejectSave=reject;}):normal(name,args));
  fireEvent.change(screen.getByLabelText("答案字号"),{target:{value:"25"}});await waitFor(()=>expect(rejectSave).toBeTypeOf("function"));
  expect(screen.queryByText("保存中…",{exact:true})).toBeNull();expect(document.querySelector(".settings-autosave-feedback")).toBeNull();
  await act(async()=>rejectSave(new Error("fixture preference write failed")));await screen.findByText(/fixture preference write failed/);
  api.invoke.mockImplementation(normal);await user.click(screen.getByRole("button",{name:"重试"}));await waitFor(()=>expect(settings.fontSize).toBe(25));
  expect(screen.queryByText("已保存",{exact:true})).toBeNull();expect(screen.queryByText(/fixture preference write failed/)).toBeNull();
 });
 it("continues automatic saving when leaving the settings module immediately",async()=>{
  const user=await settingsPage();await settingsTab(user,"偏好");fireEvent.change(screen.getByLabelText("答案字号"),{target:{value:"26"}});
  await user.click(within(screen.getByRole("navigation",{name:"页面"})).getByRole("button",{name:"个人材料"}));
  await waitFor(()=>expect(settings.fontSize).toBe(26));expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
});


describe("selected provider save isolation",()=>{
 it("does not save another provider's draft credential from the same category",async()=>{
  const user=await settingsPage();await user.type(screen.getByLabelText("模型 API Key"),"-keep-draft");
  await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"通义千问"}));
  await user.type(screen.getByLabelText("模型 API Key"),"selected-fixture-key");await user.click(screen.getByRole("button",{name:"保存"}));
  await screen.findByText("设置已保存");expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
  expect(secrets[settings.activeModel].apiKey).toBe("selected-fixture-key");
  await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));await user.click(screen.getByRole("option",{name:"DeepSeek"}));
  expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("saved-fixture-model-key-keep-draft");
 });
});

describe("compact preparation and reading controls",()=>{
 it("moves the role home, supports presets and custom text, and saves before starting",async()=>{
  const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="audio_sources"?Promise.resolve([{id:"fixture-source",name:"fixture audio",kind:"system",pid:null,recommended:true}]):normal(name,args));
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText("目标岗位");
  await user.click(screen.getByRole("button",{name:"选择常用岗位"}));await user.click(screen.getByRole("menuitem",{name:"前端工程师"}));
  await waitFor(()=>expect(settings.job).toBe("前端工程师"));fireEvent.change(screen.getByLabelText("目标岗位"),{target:{value:"custom fixture role"}});
  await user.click(within(document.querySelector(".interview-page-header") as HTMLElement).getByRole("button",{name:"开始面试"}));await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="start_session")).toBe(true));expect(settings.job).toBe("custom fixture role");
  await user.click(within(screen.getByRole("navigation",{name:"页面"})).getByRole("button",{name:"设置"}));await settingsTab(user,"偏好");expect(screen.queryByLabelText("目标岗位")).toBeNull();
 });
 it("does not start with an unsaved role after a failed preference write",async()=>{
  const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="audio_sources"?Promise.resolve([{id:"fixture-source",name:"fixture audio",kind:"system",pid:null,recommended:true}]):name==="save_preferences"?Promise.reject(new Error("fixture role write failed")):normal(name,args));
  const user=userEvent.setup();render(<App/>);const input=await screen.findByLabelText("目标岗位");fireEvent.change(input,{target:{value:"unsaved fixture role"}});
  await user.click(within(document.querySelector(".interview-page-header") as HTMLElement).getByRole("button",{name:"开始面试"}));await screen.findByText("设置未保存，请重试",{exact:false});expect(api.invoke.mock.calls.some(([name])=>name==="start_session")).toBe(false);expect((input as HTMLInputElement).value).toBe("unsaved fixture role");
 });
 it("keeps rapid opacity reversals and a failed save retry in the answer menu without saving services",async()=>{
  window.history.replaceState({},"","/?window=answer");const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"更多"}));
  const slider=screen.getByRole("slider",{name:"背景透明度"});fireEvent.change(slider,{target:{value:"30"}});expect(screen.getByText("30%",{exact:true})).toBeTruthy();fireEvent.change(slider,{target:{value:"0"}});
  await waitFor(()=>expect(settings.answerOpacity).toBe(100));const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="save_preferences"?Promise.reject(new Error("fixture opacity write failed")):normal(name,args));
  fireEvent.change(slider,{target:{value:"20"}});await screen.findByText(/fixture opacity write failed/);api.invoke.mockImplementation(normal);await user.click(screen.getByRole("button",{name:"重试"}));await waitFor(()=>expect(settings.answerOpacity).toBe(80));
  expect(api.invoke.mock.calls.filter(([name])=>name==="save_preferences").every(([,args])=>Object.keys(args.patch).join()==="answerOpacity")).toBe(true);expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("cancels the embedded browser context menu and keeps normal copy shortcuts available",async()=>{
  render(<App/>);await screen.findByLabelText("目标岗位");const event=new MouseEvent("contextmenu",{bubbles:true,cancelable:true});document.body.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
  const copy=new KeyboardEvent("keydown",{key:"c",ctrlKey:true,bubbles:true,cancelable:true});screen.getByLabelText("目标岗位").dispatchEvent(copy);expect(copy.defaultPrevented).toBe(false);
 });
});

describe("service dialogs and general settings",()=>{
 it("opens only the requested service, retains its draft after closing, and restores the trigger focus",async()=>{
  const user=await settingsPage();fireEvent.change(screen.getByLabelText("模型 API Key"),{target:{value:"dialog fixture draft"}});await closeService(user);expect(document.activeElement).toBe(screen.getByRole("button",{name:"配置回答模型"}));
  await openService(user,"语音识别");expect(screen.getByRole("dialog",{name:"语音识别"})).toBeTruthy();expect(screen.queryByLabelText("模型 API Key")).toBeNull();await closeService(user);await openService(user,"回答模型");expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("dialog fixture draft");expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("keeps network in preferences and saves theme and closing behavior without committing a service key",async()=>{
  const user=await settingsPage();fireEvent.change(screen.getByLabelText("模型 API Key"),{target:{value:"unsaved fixture key"}});await closeService(user);expect(screen.queryByText("网络",{exact:true})).toBeNull();await settingsTab(user,"偏好");expect(screen.getByRole("heading",{name:"网络"})).toBeTruthy();
  await user.click(screen.getByRole("button",{name:"深色"}));await waitFor(()=>expect(document.documentElement.classList.contains("dark")).toBe(true));await waitFor(()=>expect(settings.theme).toBe("dark"));await user.click(screen.getByRole("combobox",{name:"关闭主窗口时"}));await user.click(screen.getByRole("option",{name:"退出程序"}));await waitFor(()=>expect(settings.closeAction).toBe("quit"));expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("adds a vendor in the same dialog and Escape returns to its configuration",async()=>{
  const user=await settingsPage();await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));expect(screen.getAllByRole("dialog")).toHaveLength(1);await user.keyboard("{Escape}");expect(screen.getByRole("dialog",{name:"回答模型"})).toBeTruthy();expect(screen.getByLabelText("模型 API Key")).toBeTruthy();
 });
});

describe("answer theme synchronization",()=>{
 it("applies a saved theme in the answer window and follows a main-window settings event",async()=>{
  settings.theme="dark";window.history.replaceState({},"","/?window=answer");render(<App/>);await waitFor(()=>expect(document.documentElement.classList.contains("dark")).toBe(true));settings.theme="light";
  await act(async()=>api.channel?.onmessage({type:"settingsChanged",sessionId:""}));await waitFor(()=>expect(document.documentElement.classList.contains("dark")).toBe(false));
 });
});


describe("model discovery and shared history reader",()=>{
 it("fetches using current key, endpoint and proxy, supports keyboard selection without saving",async()=>{
  const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="list_provider_models"?Promise.resolve([{id:"fixture-alpha"},{id:"fixture-beta"}]):normal(name,args));
  const user=await settingsPage();
  fireEvent.change(screen.getByLabelText("模型 API Key"),{target:{value:"fixture-current-key"}});
  fireEvent.change(screen.getByLabelText("Base URL"),{target:{value:"https://fixture.invalid/current/v1"}});
  await user.click(screen.getByRole("button",{name:"获取模型"}));
  await screen.findByRole("option",{name:"fixture-beta"});
  const call=api.invoke.mock.calls.find(([name])=>name==="list_provider_models")![1];
  expect(call.secret.apiKey).toBe("fixture-current-key");expect(call.provider.baseUrl).toBe("https://fixture.invalid/current/v1");expect(call.network).toEqual(settings.network);
  const input=screen.getByRole("combobox",{name:"模型"});input.focus();await user.keyboard("{ArrowDown}{Enter}");
  expect((input as HTMLInputElement).value).toBe("fixture-alpha");expect(screen.queryByRole("listbox")).toBeNull();
  expect(settings.providers.find(p=>p.id==="deepseek")!.model).not.toBe("fixture-alpha");
  expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("ignores a late catalog after credentials change and retains manual input after unsupported errors",async()=>{
  const normal=api.invoke.getMockImplementation()!;let finish!:(value:unknown)=>void;
  api.invoke.mockImplementation((name,args)=>name==="list_provider_models"?new Promise(resolve=>{finish=resolve;}):normal(name,args));
  const user=await settingsPage();await user.click(screen.getByRole("button",{name:"获取模型"}));
  fireEvent.change(screen.getByLabelText("模型 API Key"),{target:{value:"fixture-next-key"}});
  await act(async()=>finish([{id:"stale-model"}]));expect(screen.queryByRole("option",{name:"stale-model"})).toBeNull();
  api.invoke.mockImplementation((name,args)=>name==="list_provider_models"?Promise.reject("此接口不支持获取模型，可直接输入模型名称"):normal(name,args));
  const input=screen.getByRole("combobox",{name:"模型"});fireEvent.change(input,{target:{value:"custom-model"}});
  await user.click(screen.getByRole("button",{name:"获取模型"}));await screen.findByText("此接口不支持获取模型，可直接输入模型名称");expect((input as HTMLInputElement).value).toBe("custom-model");
  expect(screen.queryByRole("status",{name:/通知/})).toBeNull();
 });
 it("keeps catalogs isolated by provider and restores the same provider's session cache",async()=>{
  const normal=api.invoke.getMockImplementation()!;let calls=0;
  api.invoke.mockImplementation((name,args)=>name==="list_provider_models"?(calls++,Promise.resolve([{id:"fixture-cached-model"}])):normal(name,args));
  const user=await settingsPage();await user.click(screen.getByRole("button",{name:"获取模型"}));await screen.findByRole("option",{name:"fixture-cached-model"});await user.keyboard("{Escape}");
  await closeService(user);await openService(user,"回答模型");
  await user.click(screen.getByRole("button",{name:"展开模型列表"}));expect(screen.getByRole("option",{name:"fixture-cached-model"})).toBeTruthy();await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"通义千问"}));
  expect((screen.getByRole("button",{name:"展开模型列表"}) as HTMLButtonElement).disabled).toBe(true);expect(calls).toBe(1);
 });
 it("loads the newest history and remembers search, tabs and expanded questions across module changes",async()=>{
  const records=[{id:"older",title:"fixture older",createdAt:1,endedAt:2},{id:"latest",title:"fixture latest",createdAt:3,endedAt:4}];
  const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="snapshot"?Promise.resolve({...snapshot(),sessions:records}):name==="session_detail"?Promise.resolve({answers:previewAnswers.map(a=>({...a,sessionId:args.id})),transcripts:previewTranscripts}):normal(name,args));
  const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));
  await within(document.querySelector(".review-document") as HTMLElement).findByRole("button",{name:name=>name.includes(previewAnswers[0].question)});
  expect(screen.getByRole("button",{name:/^fixture latest/}).getAttribute("aria-current")).toBe("true");
  await user.click(within(document.querySelector(".review-document") as HTMLElement).getByRole("button",{name:name=>name.includes(previewAnswers[1].question)}));
  await user.click(screen.getByRole("tab",{name:/完整转写/}));
  fireEvent.change(screen.getByRole("textbox",{name:"搜索历史记录"}),{target:{value:"fixture"}});
  await user.click(within(screen.getByRole("navigation",{name:"页面"})).getByRole("button",{name:"设置"}));
  await user.click(within(screen.getByRole("navigation",{name:"页面"})).getByRole("button",{name:"历史记录"}));
  expect((screen.getByRole("textbox",{name:"搜索历史记录"}) as HTMLInputElement).value).toBe("fixture");
  expect(screen.getByRole("tab",{name:/完整转写/}).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("tab",{name:/问答/}));expect(within(document.querySelector(".review-document") as HTMLElement).getByRole("button",{name:name=>name.includes(previewAnswers[1].question)}).getAttribute("aria-expanded")).toBe("true");
 });
 it("keeps history request errors local, retries, and discards the old session's late response",async()=>{
  const records=[{id:"older",title:"fixture older",createdAt:1,endedAt:2},{id:"latest",title:"fixture latest",createdAt:3,endedAt:4}];
  const normal=api.invoke.getMockImplementation()!;let fail=true,finish!:(value:unknown)=>void;
  api.invoke.mockImplementation((name,args)=>name==="snapshot"?Promise.resolve({...snapshot(),sessions:records}):name==="session_detail"?(args.id==="latest"?(fail?Promise.reject("fixture history failure"):Promise.resolve({answers:[],transcripts:[]})):new Promise(resolve=>{finish=resolve;})):normal(name,args));
  const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));await screen.findByText("fixture history failure");
  fail=false;await user.click(screen.getByRole("button",{name:"重试读取"}));await screen.findByRole("heading",{name:"本场暂无参考答案"});
  await user.click(screen.getByRole("button",{name:/^fixture older/}));await screen.findByText("正在读取…");
  await user.click(screen.getByRole("button",{name:/^fixture latest/}));await screen.findByRole("heading",{name:"本场暂无参考答案"});
  await act(async()=>finish({answers:[{...previewAnswers[0],question:"stale fixture question"}],transcripts:[]}));
  expect(screen.queryByText("stale fixture question")).toBeNull();
 });
});

it("requires a current key before model discovery without saving or falling back",async()=>{
 const user=await settingsPage();fireEvent.change(screen.getByLabelText("模型 API Key"),{target:{value:""}});
 await user.click(screen.getByRole("button",{name:"获取模型"}));await screen.findByText("请先填写 API Key");
 expect(api.invoke.mock.calls.some(([name])=>name==="list_provider_models"||name==="save_services")).toBe(false);
 expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
});

it("keeps large model lists responsive while searching across the entire fetched catalog",async()=>{
 const normal=api.invoke.getMockImplementation()!;
 api.invoke.mockImplementation((name,args)=>name==="list_provider_models"?Promise.resolve(Array.from({length:350},(_,i)=>({id:`fixture-model-${i}`}))):normal(name,args));
 const user=await settingsPage();await user.click(screen.getByRole("button",{name:"获取模型"}));await screen.findByText("继续输入以筛选");
 expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(200);
 fireEvent.change(screen.getByRole("combobox",{name:"模型"}),{target:{value:"fixture-model-349"}});
 await user.click(screen.getByRole("option",{name:"fixture-model-349"}));
 expect((screen.getByRole("combobox",{name:"模型"}) as HTMLInputElement).value).toBe("fixture-model-349");
});

describe("quiet history reading",()=>{
 function records(){const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="snapshot"?Promise.resolve({...snapshot(),sessions:[{id:"quiet",title:"fixture quiet interview",createdAt:1,endedAt:3600001}]}):name==="session_detail"?Promise.resolve({answers:previewAnswers,transcripts:previewTranscripts}):normal(name,args));}
 it("supports a keyboard edge toggle and restores list search and selection after reopening",async()=>{
  records();const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));
  await screen.findByRole("tab",{name:"问答"});fireEvent.change(screen.getByRole("textbox",{name:"搜索历史记录"}),{target:{value:"quiet"}});
  const toggle=screen.getByRole("button",{name:"收起记录列表"});toggle.focus();await user.keyboard(" ");
  expect(screen.getByRole("button",{name:"展开记录列表"}).getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("history-session-index")?.hasAttribute("inert")).toBe(true);expect(screen.queryByRole("textbox",{name:"搜索历史记录"})).toBeNull();
  await user.keyboard("{Enter}");expect((screen.getByRole("textbox",{name:"搜索历史记录"}) as HTMLInputElement).value).toBe("quiet");
  expect(screen.getByRole("button",{name:/^fixture quiet interview/}).getAttribute("aria-current")).toBe("true");
 });
 it("keeps the index collapsed and the reading tab when switching modules",async()=>{
  records();const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));await screen.findByRole("tab",{name:"问答"});
  await user.click(screen.getByRole("tab",{name:"完整转写"}));await user.click(screen.getByRole("button",{name:"收起记录列表"}));
  const nav=within(screen.getByRole("navigation",{name:"页面"}));await user.click(nav.getByRole("button",{name:"设置"}));await user.click(nav.getByRole("button",{name:"历史记录"}));
  expect(screen.getByRole("button",{name:"展开记录列表"})).toBeTruthy();expect(screen.getByRole("tab",{name:"完整转写"}).getAttribute("aria-selected")).toBe("true");
 });
 it("retains export, session information and a working question directory in the compact menu",async()=>{
  records();const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));await screen.findByRole("tab",{name:"问答"});
  await user.click(screen.getByRole("button",{name:"复盘操作"}));expect(screen.getByRole("menuitem",{name:"导出 Markdown"})).toBeTruthy();expect(screen.getByLabelText("面试信息").textContent).toContain("时长");
  await user.click(screen.getByRole("menuitem",{name:"问题目录"}));const dialog=screen.getByRole("dialog",{name:"问题目录"});
  await user.click(within(dialog).getByRole("button",{name:name=>name.includes(previewAnswers[1].question)}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(document.activeElement).toBe(screen.getByRole("button",{name:"复盘操作"}));
  expect(within(document.querySelector(".review-document") as HTMLElement).getByRole("button",{name:previewAnswers[1].question}).getAttribute("aria-expanded")).toBe("true");
 });
});

it("shows dates once per history group and keeps duplicate times even in filtered results",async()=>{
 const date=(day:number,hour:number)=>new Date(2026,9,day,hour).getTime();
 const records=[{id:"d1",title:"duplicate fixture",createdAt:date(22,10),endedAt:date(22,11)},{id:"d2",title:"duplicate fixture",createdAt:date(22,11),endedAt:date(22,12)},{id:"unique",title:"unique fixture",createdAt:date(22,12),endedAt:date(22,13)},{id:"prior",title:"duplicate fixture",createdAt:date(21,10),endedAt:date(21,11)}];
 const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="snapshot"?Promise.resolve({...snapshot(),sessions:records}):normal(name,args));
 const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"历史记录"}));await screen.findByRole("button",{name:"unique fixture"});
 const index=document.getElementById("history-session-index")!;expect(index.querySelectorAll(".history-date-group")).toHaveLength(2);expect(index.querySelectorAll("time")).toHaveLength(2);
 expect(within(index).getByRole("button",{name:"unique fixture"}).querySelector("time")).toBeNull();
 fireEvent.change(screen.getByRole("textbox",{name:"搜索历史记录"}),{target:{value:"11:00"}});
 expect(index.querySelectorAll(".history-row")).toHaveLength(1);expect(index.querySelector("time")?.textContent).toBe("11:00");
 fireEvent.change(screen.getByRole("textbox",{name:"搜索历史记录"}),{target:{value:"10月22日"}});expect(index.querySelectorAll(".history-row")).toHaveLength(3);
 fireEvent.change(screen.getByRole("textbox",{name:"搜索历史记录"}),{target:{value:"2026-10-21"}});expect(index.querySelectorAll(".history-row")).toHaveLength(1);
});
it("keeps a custom interview name when the compact name editor is dismissed and reopened",async()=>{
 const user=userEvent.setup();render(<App/>);await screen.findByLabelText("目标岗位");expect(screen.queryByLabelText("会话名称")).toBeNull();
 await user.click(screen.getByRole("button",{name:"本次面试选项"}));await user.type(screen.getByLabelText("会话名称"),"fixture compact name");await user.keyboard("{Escape}");
 await waitFor(()=>expect(screen.queryByLabelText("会话名称")).toBeNull());await user.click(screen.getByRole("button",{name:"本次面试选项"}));const name=screen.getByLabelText("会话名称") as HTMLInputElement;expect(name.value).toBe("fixture compact name");expect(document.activeElement).not.toBe(name);expect(document.activeElement).toBe(screen.getByRole("dialog",{name:"面试名称"}));await user.tab();expect(document.activeElement).toBe(name);await user.keyboard("{End}X");expect(name.value).toBe("fixture compact nameX");await user.keyboard("{Enter}");
 expect(api.invoke.mock.calls.some(([name])=>name==="save_preferences"||name==="save_services")).toBe(false);
});


it("previews a theme immediately and retains it through a failed preference save and retry",async()=>{
 const normal=api.invoke.getMockImplementation()!;let fail=true;
 api.invoke.mockImplementation((name,args)=>name==="save_preferences"&&fail?Promise.reject(new Error("fixture theme write failed")):normal(name,args));
 const user=await settingsPage();await closeService(user);await settingsTab(user,"偏好");const savedTheme=settings.theme;await user.click(screen.getByRole("button",{name:"深色"}));
 expect(document.documentElement.classList.contains("dark")).toBe(true);
 await screen.findByText(/fixture theme write failed/);expect(settings.theme).toBe(savedTheme);expect(document.documentElement.classList.contains("dark")).toBe(true);
 fail=false;await user.click(screen.getByRole("button",{name:/^重试$/}));await waitFor(()=>expect(settings.theme).toBe("dark"));
 expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
});


describe("manual question shortcut",()=>{
 const session={id:"manual-shortcut-fixture",title:"fixture",createdAt:1,endedAt:null};
 it("shows a configurable manual binding without the redundant data note",async()=>{
  const user=await settingsPage();await closeService(user);await settingsTab(user,"数据");expect(screen.queryByText("包含材料和面试记录，不含密钥。")).toBeNull();
  await settingsTab(user,"快捷键");expect((screen.getByLabelText("手动提问") as HTMLInputElement).value).toBe("Ctrl+Shift+M");
  await user.click(screen.getByRole("button",{name:"停用手动提问快捷键"}));await waitFor(()=>expect(settings.shortcuts.manual).toBe(""));
  const input=screen.getByLabelText("手动提问");fireEvent.keyDown(input,{key:"m",code:"KeyM",ctrlKey:true,altKey:true});await waitFor(()=>expect(settings.shortcuts.manual).toBe("Ctrl+Alt+M"));
 });
 it("hands focus from the open menu to the input on a native request and preserves draft/caret on repeats",async()=>{
  window.history.replaceState({},"","/?window=answer");initialSnapshot=Promise.resolve({...snapshot(),session});const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole("button",{name:"更多"}));
  act(()=>api.channel?.onmessage({type:"manualQuestionRequested",sessionId:session.id}));
  const input=await screen.findByRole("textbox",{name:"手动输入问题"});await waitFor(()=>expect(document.activeElement).toBe(input));await user.type(input,"fixture draft");(input as HTMLTextAreaElement).setSelectionRange(2,2);
  act(()=>api.channel?.onmessage({type:"manualQuestionRequested",sessionId:session.id}));await waitFor(()=>expect(document.activeElement).toBe(input));expect((input as HTMLTextAreaElement).value).toBe("fixture draft");expect((input as HTMLTextAreaElement).selectionStart).toBe(2);
  await user.keyboard("{Escape}");await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  act(()=>api.channel?.onmessage({type:"manualQuestionRequested",sessionId:"stale-session"}));expect(screen.queryByRole("dialog")).toBeNull();
 });
});


describe("screenshot model assignment",()=>{
 it("saves an exclusive screenshot role explicitly, preserves it while editing another model, and disables it",async()=>{
  const other={...settings.providers.find(p=>p.kind==="llm")!,id:"fixture-vision",name:"Fixture Vision",baseUrl:"https://fixture.example/v1",model:"fixture-vision"};settings.providers.push(other);
  const user=await settingsPage();const sw=()=>screen.getByRole("switch",{name:"识图"});expect(sw().getAttribute("aria-checked")).toBe("false");
  await user.click(sw());expect(settings.screenshotModel??"").toBe("");expect(api.invoke.mock.calls.some(([name])=>name==="save_preferences")).toBe(false);
  await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.screenshotModel).toBe("deepseek"));
  await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));await user.click(screen.getByRole("option",{name:"Fixture Vision"}));expect(sw().getAttribute("aria-checked")).toBe("false");
  await user.click(sw());await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.screenshotModel).toBe(other.id));
  await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));await user.click(screen.getByRole("option",{name:"DeepSeek"}));expect(sw().getAttribute("aria-checked")).toBe("false");
  await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.activeModel).toBe("deepseek"));expect(settings.screenshotModel).toBe(other.id);
  await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));await user.click(screen.getByRole("option",{name:"Fixture Vision"}));expect(sw().getAttribute("aria-checked")).toBe("true");await user.click(sw());await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.screenshotModel).toBe(""));
  expect(api.invoke.mock.calls.filter(([name])=>name==="save_services").every(([,args])=>args.services.group==="model")).toBe(true);
 });
 it("removes a deleted screenshot assignment without changing unrelated services",async()=>{
  const {withoutProvider}=await import("./lib/provider-presets");const next=withoutProvider({...settings,screenshotModel:"deepseek"},"deepseek");expect(next.screenshotModel).toBe("");expect(next.asrProvider).toBe(settings.asrProvider);expect(next.ocrProvider).toBe(settings.ocrProvider);
 });
});


describe("answer generation preferences",()=>{
 it("autosaves the word target in preferences, leaves service keys untouched and rejects invalid intermediate input",async()=>{
  const user=await settingsPage();await closeService(user);await settingsTab(user,"偏好");const input=screen.getByRole("spinbutton",{name:"生成字数"});expect((input as HTMLInputElement).value).toBe("200");
  fireEvent.change(input,{target:{value:"500"}});await waitFor(()=>expect(settings.answerWords).toBe(500));const before=api.invoke.mock.calls.filter(([name])=>name==="save_preferences").length;fireEvent.change(input,{target:{value:"20"}});await new Promise(resolve=>setTimeout(resolve,400));expect(api.invoke.mock.calls.filter(([name])=>name==="save_preferences")).toHaveLength(before);await user.click(screen.getByRole("heading",{name:"面试与阅读"}));await waitFor(()=>expect((input as HTMLInputElement).value).toBe("500"));expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
 });
 it("saves word count and the bounded background transparency range from the answer menu without services",async()=>{
  window.history.replaceState({},"","/?window=answer");const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"更多"}));const words=screen.getByRole("spinbutton",{name:"生成字数"});fireEvent.change(words,{target:{value:"300"}});await waitFor(()=>expect(settings.answerWords).toBe(300));const slider=screen.getByRole("slider",{name:"背景透明度"});expect(slider.getAttribute("max")).toBe("80");fireEvent.change(slider,{target:{value:"80"}});await waitFor(()=>expect(settings.answerOpacity).toBe(20));await waitFor(()=>expect((slider as HTMLInputElement).value).toBe("80"));fireEvent.change(slider,{target:{value:"40"}});await waitFor(()=>expect(settings.answerOpacity).toBe(60));expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);await user.keyboard("{Escape}");expect(screen.queryByRole("menu")).toBeNull();
 });
});


it("waits for the requested word target to be saved before generating an answer",async()=>{
 window.history.replaceState({},"","/?window=answer");initialSnapshot=Promise.resolve({...snapshot(),session:{id:"word-order-fixture",title:"fixture",createdAt:1,endedAt:null}});const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"更多"}));fireEvent.change(screen.getByRole("spinbutton",{name:"生成字数"}),{target:{value:"500"}});await user.keyboard("{Escape}");await user.click(screen.getByRole("button",{name:"立即回答"}));await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="request_answer")).toBe(true));const names=api.invoke.mock.calls.map(([name])=>name);expect(names.indexOf("save_preferences")).toBeLessThan(names.indexOf("request_answer"));expect(settings.answerWords).toBe(500);
});


describe("contextual setup and material roles",()=>{
 it("saves missing services on home and folds only after explicit sound detection",async()=>{
  secrets={};const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation((name,args)=>name==="audio_sources"?Promise.resolve([{id:"setup-source",name:"fixture system audio",kind:"system",pid:null,recommended:true}]):normal(name,args));
  const user=userEvent.setup();render(<App/>);
  const guide=await screen.findByRole("region",{name:"首次使用引导"});expect(within(guide).getByRole("button",{name:"连接语音"})).toBeTruthy();
  await user.click(within(guide).getByRole("button",{name:"连接模型"}));let dialog=await screen.findByRole("dialog",{name:"回答模型"});
  await user.type(within(dialog).getByLabelText("模型 API Key"),"new-fixture-model-key");await user.click(within(dialog).getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(screen.getByRole("region",{name:"首次使用引导"})).toBeTruthy();expect(screen.getByRole("button",{name:"已配置"})).toBeTruthy();
  await user.click(screen.getByRole("button",{name:"连接语音"}));dialog=await screen.findByRole("dialog",{name:"语音识别"});
  await user.type(within(dialog).getByLabelText("RTasr API Key"),"new-fixture-asr-key");await user.click(within(dialog).getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(screen.getByRole("region",{name:"首次使用引导"})).toBeTruthy();
  expect(api.invoke.mock.calls.filter(([name])=>name==="test_audio")).toHaveLength(0);
  await user.click(screen.getByRole("button",{name:"检测声音"}));const audio=await screen.findByRole("dialog",{name:"会议声音"});
  await user.click(within(audio).getByRole("button",{name:"检测声音"}));await within(audio).findByText("检测通过");
  await user.click(within(audio).getByRole("button",{name:"完成"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(screen.queryByRole("region",{name:"首次使用引导"})).toBeNull();expect(screen.getByRole("region",{name:"最近面试"})).toBeTruthy();
  expect(api.invoke.mock.calls.filter(([name])=>name==="test_audio")).toHaveLength(1);
  const toggle=screen.getByRole("button",{name:"使用引导"});expect(toggle.getAttribute("aria-expanded")).toBe("false");expect(document.activeElement).toBe(toggle);
  await user.click(toggle);expect(screen.getByRole("button",{name:"已检测"})).toBeTruthy();
  expect(api.invoke.mock.calls.filter(([name])=>["test_provider","list_provider_models","start_session"].includes(name))).toHaveLength(0);
  expect(api.invoke.mock.calls.filter(([name])=>name==="save_services").map(([,args])=>args.services.group)).toEqual(["model","asr"]);
 });
 it("keeps a visible keyboard-accessible guide entry on configured home and removes it from About",async()=>{
  const user=userEvent.setup();render(<App/>);const toggle=await screen.findByRole("button",{name:"使用引导"});
  expect(toggle.closest(".preparation-setup")).toBeNull();expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("heading",{name:"会前准备"})).toBeTruthy();
  toggle.focus();await user.keyboard(" ");expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region",{name:"首次使用引导"})).toBeTruthy();expect(screen.getByRole("button",{name:"检测声音"})).toBeTruthy();
  await user.keyboard(" ");expect(toggle.getAttribute("aria-expanded")).toBe("false");expect(document.activeElement).toBe(toggle);
  await user.click(screen.getByRole("button",{name:"设置"}));await user.click(screen.getByRole("tab",{name:"关于"}));
  expect(screen.queryByRole("button",{name:"使用引导"})).toBeNull();
 });
 it("can reopen skipped setup from the home header without losing service drafts",async()=>{
  secrets={};const user=userEvent.setup();render(<App/>);const toggle=await screen.findByRole("button",{name:"使用引导"});
  await screen.findByRole("region",{name:"首次使用引导"});await user.click(screen.getByRole("button",{name:"稍后配置"}));
  expect(screen.queryByRole("region",{name:"首次使用引导"})).toBeNull();await user.click(toggle);
  expect(screen.getByRole("region",{name:"首次使用引导"})).toBeTruthy();await user.click(screen.getByRole("button",{name:"连接模型"}));
  expect(await screen.findByRole("dialog",{name:"回答模型"})).toBeTruthy();
  expect(api.invoke.mock.calls.filter(([name])=>["test_audio","test_provider","start_session"].includes(name))).toHaveLength(0);
 });
 it("retains a failed setup draft and supports closing, skipping and revisiting",async()=>{
  secrets={};const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation(async(name,args)=>{if(name==="save_services")throw "fixture save failed";return normal(name,args);});
  const user=userEvent.setup();render(<App/>);await user.click(await screen.findByRole("button",{name:"连接模型"}));let dialog=await screen.findByRole("dialog",{name:"回答模型"});await user.type(within(dialog).getByLabelText("模型 API Key"),"fixture-unsaved-key");await user.click(within(dialog).getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(true));expect(screen.getByRole("dialog",{name:"回答模型"})).toBeTruthy();expect(secrets.deepseek).toBeUndefined();
  await user.click(within(dialog).getByRole("button",{name:"关闭"}));await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());await user.click(screen.getByRole("button",{name:"稍后配置"}));expect(screen.queryByRole("region",{name:"首次使用引导"})).toBeNull();await user.click(screen.getByRole("button",{name:"配置服务"}));await user.click(screen.getByRole("button",{name:"连接模型"}));dialog=await screen.findByRole("dialog",{name:"回答模型"});expect((within(dialog).getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("fixture-unsaved-key");
 });
 it("keeps legacy material kinds and disabled flags, imports new knowledge explicitly and resets batch selection",async()=>{
  const docs=[{id:"resume",title:"原简历",kind:"resume",text:"原个人事实",enabled:false,updatedAt:1},{id:"project",title:"原项目",kind:"project",text:"原项目事实",enabled:true,updatedAt:2},{id:"terms",title:"术语笔记",kind:"terms",text:"知识内容",enabled:true,updatedAt:3}];const normal=api.invoke.getMockImplementation()!;
  api.invoke.mockImplementation(async(name,args)=>name==="snapshot"?{...snapshot(),materials:structuredClone(docs)}:name==="import_document"?"fixture knowledge text":normal(name,args));
  const user=userEvent.setup();render(<App/>);await user.click(screen.getByRole("button",{name:"个人材料"}));await screen.findByText("原简历");expect(screen.queryByText("术语笔记")).toBeNull();
  await user.click(screen.getByRole("button",{name:"批量管理"}));await user.click(screen.getByRole("checkbox",{name:"选择材料：原项目"}));await user.click(screen.getByRole("button",{name:"知识资料"}));expect(screen.queryByText("原项目")).toBeNull();expect(screen.getByText("术语笔记")).toBeTruthy();expect(screen.getByText("已选 0 份")).toBeTruthy();
  await user.click(screen.getByRole("button",{name:"新建材料"}));let dialog=await screen.findByRole("dialog",{name:"确认材料内容"});expect(within(dialog).getByRole("combobox",{name:"材料类型"}).textContent).toBe("知识资料");await user.keyboard("{Escape}");
  vi.mocked(openDialog).mockResolvedValueOnce("C:/fixture/knowledge.md");await user.click(screen.getByRole("button",{name:"导入文件"}));dialog=await screen.findByRole("dialog",{name:"确认材料内容"});expect(within(dialog).getByRole("combobox",{name:"材料类型"}).textContent).toBe("知识资料");
  expect(docs.map(d=>[d.id,d.kind,d.enabled])).toEqual([["resume","resume",false],["project","project",true],["terms","terms",true]]);
 });
});


describe("immediate window appearance previews",()=>{
 it("updates only the answer surface before the debounced opacity save and publishes a preview",async()=>{
  window.history.replaceState({},"","/?window=answer");const user=userEvent.setup();const view=render(<App/>);await user.click(await screen.findByRole("button",{name:"更多"}));const slider=screen.getByRole("slider",{name:"背景透明度"});fireEvent.change(slider,{target:{value:"80"}});
  expect((view.container.querySelector(".answer-window") as HTMLElement).style.getPropertyValue("--answer-background-opacity")).toBe("0.2");expect((view.container.querySelector(".answer-window") as HTMLElement).style.opacity).toBe("");expect(api.invoke.mock.calls.some(([name])=>name==="save_preferences")).toBe(false);
  await waitFor(()=>expect(api.invoke.mock.calls.some(([name,args])=>name==="preview_answer_opacity"&&args.opacity===20)).toBe(true));expect(api.invoke.mock.calls.some(([name])=>name==="save_preferences")).toBe(false);await waitFor(()=>expect(settings.answerOpacity).toBe(20));
 });
 it("accepts a main-window preview without writing services or preferences from the answer window",async()=>{
  window.history.replaceState({},"","/?window=answer");const view=render(<App/>);await screen.findByRole("button",{name:"更多"});act(()=>api.channel?.onmessage({type:"answerOpacityPreview",sessionId:"",opacity:35}));expect((view.container.querySelector(".answer-window") as HTMLElement).style.getPropertyValue("--answer-background-opacity")).toBe("0.35");expect(api.invoke.mock.calls.some(([name])=>["save_preferences","save_services"].includes(name))).toBe(false);
 });
 it("does not hold the WebView theme behind native IPC and keeps one debounced save",async()=>{
  const normal=api.invoke.getMockImplementation()!;let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});api.invoke.mockImplementation((name,args)=>name==="preview_theme"?pending:normal(name,args));
  const user=await settingsPage();await closeService(user);await settingsTab(user,"偏好");await user.click(screen.getByRole("button",{name:"深色"}));await waitFor(()=>expect(api.invoke.mock.calls.some(([name])=>name==="preview_theme")).toBe(true));expect(document.documentElement.classList.contains("dark")).toBe(true);
  await act(async()=>{release();});await waitFor(()=>expect(document.documentElement.classList.contains("dark")).toBe(true));await waitFor(()=>expect(settings.theme).toBe("dark"));const names=api.invoke.mock.calls.map(([name])=>name);expect(names.indexOf("preview_theme")).toBeLessThan(names.indexOf("save_preferences"));
 });
});

it("supports independent compatible services with incrementing default names and custom names",async()=>{
 const user=await settingsPage();
 for(const name of ["兼容接口","兼容接口 2","兼容接口 3"]){
  await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.click(within(screen.getByRole("dialog")).getByRole("button",{name:"兼容接口"}));
  await user.click(screen.getByText("接口设置",{exact:true}));expect((screen.getByLabelText("显示名称")as HTMLInputElement).value).toBe(name);
 }
 await user.clear(screen.getByLabelText("显示名称"));await user.type(screen.getByLabelText("显示名称"),"本地模型");
 await user.click(screen.getByRole("combobox",{name:"当前模型服务"}));expect(screen.getByRole("option",{name:"本地模型"})).toBeTruthy();expect(screen.getByRole("option",{name:"兼容接口 2"})).toBeTruthy();
});
it("places connection feedback in the footer beside delete without a separate result card",async()=>{
 const user=await settingsPage();await user.click(screen.getByRole("button",{name:"检测"}));const status=await screen.findByText("连接成功 · 1 ms");
 expect(status.parentElement?.classList.contains("settings-provider-check")).toBe(true);expect(within(status.parentElement!).getByRole("button",{name:"删除服务"})).toBeTruthy();expect(document.querySelector(".settings-test-result")).toBeNull();
});
it("offers Volcengine ASR without requiring the other providers' App ID",async()=>{
 const user=await settingsPage();await closeService(user);await user.click(screen.getByRole("button",{name:"配置语音识别"}));await user.click(screen.getByRole("button",{name:"添加语音识别服务"}));await user.click(screen.getByRole("button",{name:/火山引擎/}));
 expect(screen.queryByLabelText("App ID")).toBeNull();expect(screen.getByRole("button",{name:"获取密钥"})).toBeTruthy();await user.click(screen.getByText("接口设置",{exact:true}));expect((screen.getByLabelText("资源 ID")as HTMLInputElement).value).toBe("volc.seedasr.sauc.duration");
});

it("marks a reasoning-only probe response as a local failure rather than a grey success",async()=>{
 const normal=api.invoke.getMockImplementation()!;api.invoke.mockImplementation((name,args)=>name==="test_provider"?Promise.reject("仅返回思考内容，请换用非思考模型重试"):normal(name,args));
 const user=await settingsPage();await user.click(screen.getByRole("button",{name:"检测"}));const result=await screen.findByText("仅返回思考内容");expect(result.getAttribute("aria-label")).toBe("仅返回思考内容，请换用非思考模型重试");expect(result.classList.contains("text-destructive")).toBe(true);expect(result.closest(".settings-provider-check")).toBeTruthy();
});

it("adds independent OpenAI speech services using HTTP without a realtime protocol selector",async()=>{
 const user=await settingsPage();await openService(user,"语音识别");
 await user.click(screen.getByRole("button",{name:"添加语音识别服务"}));expect(screen.queryByRole("button",{name:"兼容接口"})).toBeNull();await user.click(screen.getByRole("button",{name:"OpenAI"}));
 expect(screen.queryByRole("combobox",{name:"实时协议"})).toBeNull();expect(screen.queryByLabelText("App ID")).toBeNull();expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe("gpt-transcribe");
 await user.click(screen.getByRole("button",{name:"获取密钥"}));expect(api.invoke.mock.calls.some(([name,args])=>name==="open_provider_help"&&args.help==="openai")).toBe(true);
 await user.click(screen.getByText("接口设置",{exact:true}));expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("OpenAI");fireEvent.change(screen.getByLabelText("Base URL"),{target:{value:"https://voice.fixture.invalid/v1"}});
 fireEvent.change(screen.getByLabelText("模型"),{target:{value:"fixture-transcribe"}});fireEvent.change(screen.getByLabelText("语音 API Key"),{target:{value:"fixture-openai-key"}});
 await user.click(screen.getByRole("button",{name:"检测"}));await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="test_provider").at(-1)?.[1].provider.kind).toBe("openai-asr"));
 await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.providers.find(p=>p.id===settings.asrProvider)?.kind).toBe("openai-asr"));const saved=settings.providers.find(p=>p.id===settings.asrProvider)!;expect(saved.baseUrl).toBe("https://voice.fixture.invalid/v1");expect(secrets[saved.id].apiKey).toBe("fixture-openai-key");
 await user.click(screen.getByRole("button",{name:"添加语音识别服务"}));await user.click(screen.getByRole("button",{name:"OpenAI"}));await user.click(screen.getByText("接口设置",{exact:true}));expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("OpenAI 2");expect((screen.getByLabelText("语音 API Key") as HTMLInputElement).value).toBe("");
});
it("keeps a diagnostic slot before testing and reveals the full failure by keyboard",async()=>{
 const normal=api.invoke.getMockImplementation()!;const full="接口未返回答案正文，请检查 Chat Completions 兼容性";
 api.invoke.mockImplementation((name,args)=>name==="test_provider"?Promise.reject(full):normal(name,args));
 const user=await settingsPage();const slot=document.querySelector(".settings-test-inline")!;expect(slot.textContent).toBe("");
 await user.click(screen.getByRole("button",{name:"检测"}));const result=await screen.findByLabelText(full);expect(result).toBe(slot);expect(result.textContent).toBe("接口未返回答案正文");
 await user.click(screen.getByRole("button",{name:"删除服务"}));await user.keyboard("{Escape}");
 act(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true}));(result as HTMLElement).focus();});
 expect(await screen.findByRole("tooltip")).toHaveProperty("textContent",full);
});

it("defaults the first entered model to image recognition, saves it and never moves it to a second model",async()=>{
 secrets={};const user=await settingsPage();const toggle=()=>screen.getByRole("switch",{name:"识图"});expect(toggle().getAttribute("aria-checked")).toBe("false");
 await user.type(screen.getByLabelText("模型 API Key"),"fixture-first-model-key");expect(toggle().getAttribute("aria-checked")).toBe("true");
 await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.screenshotModel).toBe("deepseek"));
 await user.click(screen.getByRole("button",{name:"添加回答模型服务"}));await user.click(screen.getByRole("button",{name:"通义千问"}));await user.type(screen.getByLabelText("模型 API Key"),"fixture-second-model-key");expect(toggle().getAttribute("aria-checked")).toBe("false");expect(settings.screenshotModel).toBe("deepseek");
});
it("respects turning the first image default off even while continuing to enter its key",async()=>{
 secrets={};const user=await settingsPage();await user.type(screen.getByLabelText("模型 API Key"),"fixture-first");await user.click(screen.getByRole("switch",{name:"识图"}));await user.type(screen.getByLabelText("模型 API Key"),"-continued");
 expect(screen.getByRole("switch",{name:"识图"}).getAttribute("aria-checked")).toBe("false");await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.screenshotModel).toBe(""));
});

it("offers other cloud OCR only after explicit addition and saves credentials without changing answer services",async()=>{
 settings.screenshotModel="deepseek";const user=await settingsPage();await openService(user,"截图识别");
 await user.click(screen.getByRole("combobox",{name:"OCR 服务"}));expect(screen.getAllByRole("option").map(item=>item.textContent)).toEqual(["本地 · Windows OCR","有道云端 OCR"]);await user.keyboard("{Escape}");
 await user.click(screen.getByRole("button",{name:"添加截图识别服务"}));await user.click(screen.getByRole("button",{name:"有道智云 OCR"}));expect(screen.getByRole("dialog",{name:"截图识别"})).toBeTruthy();
 expect(screen.queryByRole("button",{name:"获取模型"})).toBeNull();expect(screen.queryByRole("combobox",{name:"模型"})).toBeNull();
 fireEvent.change(screen.getByLabelText("应用 ID"),{target:{value:"fixture-youdao-app"}});fireEvent.change(screen.getByLabelText("应用密钥"),{target:{value:"fixture-youdao-key"}});
 await user.click(screen.getByRole("button",{name:"获取密钥"}));expect(api.invoke.mock.calls.some(([name,args])=>name==="open_provider_help"&&args.help==="youdao")).toBe(true);
 await user.click(screen.getByRole("button",{name:"检测"}));await waitFor(()=>expect(api.invoke.mock.calls.filter(([name])=>name==="test_provider").at(-1)?.[1].provider.kind).toBe("youdao-ocr"));
 await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.providers.find(p=>p.id===settings.ocrProvider)?.kind).toBe("youdao-ocr"));
 const id=settings.ocrProvider!;expect(secrets[id].apiKey).toBe("fixture-youdao-key");expect(settings.activeModel).toBe("deepseek");expect(settings.asrProvider).toBe("xfyun");expect(settings.screenshotModel).toBe("deepseek");
 await user.click(screen.getByRole("button",{name:"添加截图识别服务"}));await user.click(screen.getByRole("button",{name:"OCR.space"}));
 expect(screen.queryByLabelText("应用 ID")).toBeNull();expect((screen.getByLabelText("OCR API Key") as HTMLInputElement).value).toBe("");
 fireEvent.change(screen.getByLabelText("OCR API Key"),{target:{value:"fixture-space-key"}});await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.providers.find(p=>p.id===settings.ocrProvider)?.kind).toBe("ocr-space"));
 expect(settings.providers.filter(p=>["youdao-ocr","ocr-space"].includes(p.kind))).toHaveLength(2);expect(secrets[id].apiKey).toBe("fixture-youdao-key");
 await user.click(screen.getByRole("combobox",{name:"OCR 服务"}));await user.click(screen.getByRole("option",{name:"本地 · Windows OCR"}));await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.ocrProvider).toBe("local"));
});
it("keeps existing legacy voice protocols and endpoints editable without migrating them to OpenAI",async()=>{
 const old={...settings.providers.find(p=>p.kind==="xfyun")!,id:"custom-asr-legacy",kind:"dashscope",name:"原语音服务",baseUrl:"wss://private.fixture.invalid/asr",model:"legacy-engine"};settings.providers.push(old);settings.asrProvider=old.id;secrets[old.id]={apiKey:"fixture-legacy-key",secretKey:""};
 const user=await settingsPage();await openService(user,"语音识别");expect((screen.getByLabelText("WebSocket 地址") as HTMLInputElement).value).toBe(old.baseUrl);await user.click(screen.getByText("接口设置",{exact:true}));expect((screen.getByRole("combobox",{name:"实时协议"}) as HTMLButtonElement).disabled).toBe(true);expect(settings.providers.find(p=>p.id===old.id)?.kind).toBe("dashscope");
});

it("includes no-key Youdao by default, tests without credentials and persists only the selected OCR",async()=>{
 const user=await settingsPage();await openService(user,"截图识别");const before=structuredClone(settings.providers);
 await user.click(screen.getByRole("combobox",{name:"OCR 服务"}));await user.click(screen.getByRole("option",{name:"有道云端 OCR"}));expect(screen.queryByText("无需密钥")).toBeNull();
 expect(screen.queryByLabelText("应用 ID")).toBeNull();expect(screen.queryByLabelText("OCR API Key")).toBeNull();expect(screen.queryByRole("button",{name:"删除服务"})).toBeNull();
 expect(api.invoke.mock.calls.some(([name])=>name==="test_provider")).toBe(false);await user.click(screen.getByRole("button",{name:"检测"}));await waitFor(()=>expect(api.invoke.mock.calls.some(([name,args])=>name==="test_provider"&&args.provider.kind==="youdao-free"&&args.secret===null)).toBe(true));
 await user.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(settings.ocrProvider).toBe("youdao-free"));expect(settings.providers).toEqual(before);expect(settings.activeModel).toBe("deepseek");expect(settings.asrProvider).toBe("xfyun");expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
 await closeService(user);await openService(user,"截图识别");expect(screen.getByRole("combobox",{name:"OCR 服务"}).textContent).toBe("有道云端 OCR");expect(api.invoke.mock.calls.some(([name,args])=>name==="read_provider_secret"&&args.providerId==="youdao-free")).toBe(false);
});

it("switches interface language immediately, persists it, and keeps service drafts intact",async()=>{
 const user=await settingsPage();
 const field=screen.getByLabelText("模型 API Key");await user.clear(field);await user.type(field,"fixture-unsaved-language-key");
 await settingsTab(user,"偏好");
 await user.click(screen.getByRole("combobox",{name:"界面语言"}));await user.click(screen.getByRole("option",{name:"English"}));
 expect(await screen.findByRole("button",{name:"Settings"})).toBeTruthy();
 await waitFor(()=>expect(api.invoke.mock.calls.some(([name,args])=>name==="save_preferences"&&args.patch.language==="en")).toBe(true));
 expect(settings.language).toBe("en");expect(settings.job).toBe("fixture job");
 expect(secrets.deepseek.apiKey).toBe("saved-fixture-model-key");
 await user.click(screen.getByRole("combobox",{name:"Interface language"}));await user.click(screen.getByRole("option",{name:"简体中文"}));
 await screen.findByRole("button",{name:"设置"});await settingsTab(user,"服务");
 expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("fixture-unsaved-language-key");
 expect(api.invoke.mock.calls.some(([name])=>name==="save_services")).toBe(false);
});
it("applies a language change received from another window without changing the role or model",async()=>{
 settings.language="en";render(<App/>);await screen.findByRole("button",{name:"Settings"});
 settings.language="zh-CN";act(()=>api.channel?.onmessage({type:"settingsChanged",sessionId:""}));
 expect(await screen.findByRole("button",{name:"设置"})).toBeTruthy();
 expect(settings.job).toBe("fixture job");expect(settings.activeModel).toBe("deepseek");
});
it("explains that Windows 10 system audio still works when process capture is unavailable",async()=>{
 const normal=api.invoke.getMockImplementation()!;
 api.invoke.mockImplementation((name,args)=>name==="audio_sources"?Promise.resolve([{id:"system",name:"全部系统声音（包含其他应用）",kind:"system",pid:null,recommended:false,processCaptureSupported:false}]):normal(name,args));
 const user=await settingsPage();await closeService(user);await user.click(screen.getByRole("button",{name:"开始面试"}));
 await user.click(screen.getByRole("button",{name:"调整会议音源"}));
 expect(await screen.findByText("当前 Windows 仅支持系统声音采集，可正常使用；无法仅采集指定应用。")).toBeTruthy();
 expect(screen.getByRole("combobox",{name:"会议音源"}).textContent).toContain("全部系统声音");
 expect(api.invoke.mock.calls.some(([name])=>name==="start_session")).toBe(false);
});
