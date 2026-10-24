// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateCaptionAction, UpdateControls } from "./components/app-updater";
import { useAppUpdater, updateBlockReason } from "./hooks/use-app-updater";
import type { Copilot } from "./hooks/use-copilot";
const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), captionHandler: null as (() => void) | null, handlers: new Map<string, (event: {payload: unknown}) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, Channel: class { onmessage = () => {}; } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
const release = { version: "0.1.51", notes: "Fixture release" };
function fixture() {
  return { native: true, loaded: true, data: { session: null }, busy: "", settingsDirty: false, editing: null,
    materialImport: { isOpen: () => false }, preferences: { retry: vi.fn().mockResolvedValue(true) } } as unknown as Copilot;
}
beforeEach(() => { vi.useFakeTimers(); api.invoke.mockReset(); api.listen.mockReset(); api.unlisten.mockReset(); api.captionHandler = null; api.handlers.clear(); localStorage.clear(); api.listen.mockImplementation(async (name, handler) => { api.handlers.set(name, handler); if (name === "app-update-install-requested") api.captionHandler = handler; return api.unlisten; }); history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });
async function ready(result: { current: ReturnType<typeof useAppUpdater> }) {
  api.invoke.mockResolvedValueOnce(release).mockResolvedValueOnce(undefined);
  await act(async () => result.current.check());
  await act(async () => result.current.download());
  expect(result.current.stage).toBe("ready");
}
describe("application updates", () => {
  it("never contacts release servers from browser preview or the answer window", async () => {
    const preview = renderHook(() => useAppUpdater({ ...fixture(), native: false }));
    await act(async () => preview.result.current.check());
    preview.unmount();
    const answer = renderHook(() => useAppUpdater(fixture(), false));
    await act(async () => answer.result.current.check());
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(api.invoke).not.toHaveBeenCalled();
  });
  it("checks once after startup without interrupting an interview", async () => {
    vi.stubEnv("DEV", false);
    const store = fixture(); store.data.session = { id: "fixture" } as never;
    api.invoke.mockResolvedValue(null);
    const { result, rerender } = renderHook(({ store }) => useAppUpdater(store), { initialProps: { store } });
    await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(api.invoke).not.toHaveBeenCalled();
    rerender({ store: { ...store, data: { ...store.data, session: null } } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.stage).toBe("current"); expect(api.invoke).toHaveBeenCalledTimes(1);
    rerender({ store: fixture() }); await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });
  it("requires a download click after checking and after an interview ends", async () => {
    const store = fixture(); store.data.session = { id: "fixture" } as never;
    api.invoke.mockResolvedValueOnce(release).mockResolvedValueOnce(undefined);
    const { result, rerender } = renderHook(({ store }) => useAppUpdater(store), { initialProps: { store } });
    await act(async () => result.current.check());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(api.invoke.mock.calls.map(call => call[0])).toEqual(["check_app_update"]);
    rerender({ store: { ...store, data: { ...store.data, session: null } } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.stage).toBe("available");
    expect(api.invoke).toHaveBeenCalledTimes(1);
    await act(async () => result.current.download());
    expect(result.current.stage).toBe("ready");
    expect(api.invoke.mock.calls.map(call => call[0])).toEqual(["check_app_update", "download_app_update"]);
  });
  it("serializes repeated checks and allows explicit retry after network failure", async () => {
    let reject!: (error: string) => void;
    api.invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { result } = renderHook(() => useAppUpdater(fixture()));
    let pending!: Promise<void>;
    act(() => { pending = result.current.check(); });
    await act(async () => result.current.check()); expect(api.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { reject("fixture network failure"); await pending; });
    expect(result.current.error).toContain("fixture network failure");
    api.invoke.mockResolvedValueOnce(null); await act(async () => result.current.check());
    expect(result.current.stage).toBe("current");
  });
  it("does not offer installation after a failed signature or download", async () => {
    api.invoke.mockResolvedValueOnce(release).mockRejectedValueOnce("更新下载或签名校验失败，请重试");
    const { result } = renderHook(() => useAppUpdater(fixture()));
    await act(async () => result.current.check()); await act(async () => result.current.download());
    expect(result.current.stage).toBe("error");
    await act(async () => result.current.install());
    expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
  });
  it("flushes pending preferences before asking native code to install", async () => {
    const store = fixture(); const { result } = renderHook(() => useAppUpdater(store)); await ready(result);
    api.invoke.mockResolvedValueOnce(undefined); await act(async () => result.current.install());
    expect(store.preferences.retry).toHaveBeenCalledOnce();
    expect(api.invoke).toHaveBeenLastCalledWith("install_app_update");
    expect(vi.mocked(store.preferences.retry).mock.invocationCallOrder[0]).toBeLessThan(api.invoke.mock.invocationCallOrder.at(-1)!);
  });
  it("keeps verified download available after failed saving or native checkpoint", async () => {
    const store = fixture(); const { result } = renderHook(() => useAppUpdater(store)); await ready(result);
    vi.mocked(store.preferences.retry).mockResolvedValueOnce(false); await act(async () => result.current.install());
    expect(result.current.stage).toBe("ready"); expect(result.current.error).toContain("偏好设置未保存");
    expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
    api.invoke.mockRejectedValueOnce("数据备份失败，未安装更新"); await act(async () => result.current.install());
    expect(result.current.stage).toBe("ready"); expect(result.current.error).toContain("数据备份失败");
  });
  it("rechecks session state after asynchronous preference saving", async () => {
    const store = fixture(); const { result, rerender } = renderHook(({ store }) => useAppUpdater(store), { initialProps: { store } }); await ready(result);
    let saved!: (value: boolean) => void;
    vi.mocked(store.preferences.retry).mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    let pending!: Promise<boolean>; act(() => { pending = result.current.install(); });
    rerender({ store: { ...store, data: { ...store.data, session: { id: "fixture" } as never } } });
    await act(async () => { saved(true); await pending; });
    expect(result.current.stage).toBe("ready"); expect(result.current.error).toContain("结束面试");
    expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
  });
  it("one tray action downloads, saves preferences and installs without a second click", async () => {
    const store = fixture(); api.invoke.mockResolvedValueOnce(release).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAppUpdater(store)); await act(async () => result.current.check());
    let success = false; await act(async () => { success = await result.current.upgrade(); });
    expect(success).toBe(true); expect(result.current.stage).toBe("installing");
    expect(api.invoke.mock.calls.map(call => call[0])).toEqual(["check_app_update", "download_app_update", "install_app_update"]);
    expect(store.preferences.retry).toHaveBeenCalledOnce();
  });
  it("one-click upgrade never installs after a failed download or signature", async () => {
    api.invoke.mockResolvedValueOnce(release).mockRejectedValueOnce("签名校验失败");
    const { result } = renderHook(() => useAppUpdater(fixture())); await act(async () => result.current.check());
    await act(async () => { expect(await result.current.upgrade()).toBe(false); });
    expect(result.current.stage).toBe("error"); expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
  });
  it("rechecks drafts after tray download and serializes repeated clicks", async () => {
    const store = fixture(); let complete!: () => void;
    api.invoke.mockResolvedValueOnce(release).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const { result, rerender } = renderHook(({ store }) => useAppUpdater(store), { initialProps: { store } });
    await act(async () => result.current.check()); let pending!: Promise<boolean>;
    act(() => { pending = result.current.upgrade(); });
    await act(async () => { expect(await result.current.upgrade()).toBe(false); });
    rerender({ store: { ...store, settingsDirty: true } });
    await act(async () => { complete(); expect(await pending).toBe(false); });
    expect(result.current.stage).toBe("ready"); expect(result.current.error).toContain("服务配置");
    expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
    rerender({ store }); await act(async () => {});
    expect(api.invoke.mock.calls.some(call => call[0] === "install_app_update")).toBe(false);
  });
  it("remembers dismissal for exactly one version across checks and restarts", async () => {
    api.invoke.mockResolvedValue(release);
    let hook = renderHook(() => useAppUpdater(fixture()));
    await act(async () => hook.result.current.check());
    act(() => hook.result.current.dismissCaption()); expect(hook.result.current.captionHidden).toBe(true);
    await act(async () => hook.result.current.check()); expect(hook.result.current.captionHidden).toBe(true);
    await act(async () => hook.result.current.download()); expect(hook.result.current.stage).toBe("ready");
    expect(hook.result.current.captionHidden).toBe(true); hook.unmount();
    hook = renderHook(() => useAppUpdater(fixture()));
    await act(async () => hook.result.current.check()); expect(hook.result.current.captionHidden).toBe(true);
    api.invoke.mockResolvedValue({ ...release, version: "0.1.52" });
    await act(async () => hook.result.current.check()); expect(hook.result.current.captionHidden).toBe(false);
    act(() => hook.result.current.dismissCaption(release.version)); expect(hook.result.current.captionHidden).toBe(false);
  });
  it("keeps dismissal usable when persistent storage is unavailable", async () => {
    api.invoke.mockResolvedValue(release); const hook = renderHook(() => useAppUpdater(fixture()));
    await act(async () => hook.result.current.check());
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("fixture storage unavailable"); });
    try { act(() => hook.result.current.dismissCaption()); expect(hook.result.current.captionHidden).toBe(true); }
    finally { write.mockRestore(); }
  });
  it("blocks restarting with unsaved service configuration or material work", () => {
    const store = fixture(); expect(updateBlockReason(store)).toBe("");
    store.settingsDirty = true; expect(updateBlockReason(store)).toContain("服务配置");
    store.settingsDirty = false; store.editing = {} as never; expect(updateBlockReason(store)).toContain("材料");
    store.editing = null; store.materialImport.isOpen = () => true; expect(updateBlockReason(store)).toContain("材料");
  });
});


describe("update installation confirmation", () => {
  it("requires an explicit second click before starting installation", () => {
    const updates = { stage: "ready", info: release, progress: 100, error: "", native: true, blockReason: "", captionHidden: false, dismissCaption: vi.fn(), upgrade: vi.fn().mockResolvedValue(true), check: vi.fn(), download: vi.fn(), install: vi.fn().mockResolvedValue(true) } as ReturnType<typeof useAppUpdater>;
    render(<UpdateControls updates={updates}/>);
    fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(updates.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "重启更新" }).at(-1)!);
    expect(updates.install).toHaveBeenCalledOnce();
  });
});


describe("native caption update action", () => {
  function readyUpdates() { return { stage: "ready", info: release, progress: 100, error: "", native: true, blockReason: "", captionHidden: false, dismissCaption: vi.fn(), upgrade: vi.fn().mockResolvedValue(true), check: vi.fn(), download: vi.fn(), install: vi.fn().mockResolvedValue(true) } as ReturnType<typeof useAppUpdater>; }
  it("adds no toolbar row and forwards fixed-place download, progress and restart states", async () => {
    api.invoke.mockResolvedValue(undefined);
    const updates = readyUpdates();
    const { container, rerender, unmount } = render(<UpdateCaptionAction updates={{ ...updates, stage: "downloading" }}/>);
    expect(container.innerHTML).toBe("");
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: false, enabled: false, mode: "downloading", progress: 100, version: release.version, english: false });
    await act(async () => {});
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: true, enabled: false, mode: "downloading", progress: 100, version: release.version, english: false });
    rerender(<UpdateCaptionAction updates={{ ...updates, stage: "available", progress: null }}/>);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: true, enabled: true, mode: "download", progress: null, version: release.version, english: false });
    act(() => api.captionHandler?.()); expect(updates.download).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    rerender(<UpdateCaptionAction updates={{ ...updates, stage: "downloading", progress: 42 }}/>);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: true, enabled: false, mode: "downloading", progress: 42, version: release.version, english: false });
    act(() => api.captionHandler?.()); expect(updates.download).toHaveBeenCalledOnce();
    rerender(<UpdateCaptionAction updates={updates}/>);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: true, enabled: true, mode: "restart", progress: 100, version: release.version, english: false });
    rerender(<UpdateCaptionAction updates={{ ...updates, blockReason: "请先保存服务配置" }}/>);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: true, enabled: false, mode: "restart", progress: 100, version: release.version, english: false });
    await act(async () => {}); unmount(); await act(async () => {});
    expect(api.unlisten).toHaveBeenCalledTimes(3);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toEqual({ visible: false, enabled: false });
  });
  it("a native caption click opens confirmation and never directly installs", async () => {
    api.invoke.mockResolvedValue(undefined); const updates = readyUpdates();
    render(<UpdateCaptionAction updates={updates}/>); await act(async () => {});
    act(() => api.captionHandler?.()); expect(screen.getByRole("alertdialog")).toBeTruthy(); expect(updates.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重启更新" })); expect(updates.install).toHaveBeenCalledOnce();
  });
  it("hides only the title-bar prompt while retaining the tray update action", async () => {
    api.invoke.mockResolvedValue(undefined); const updates = readyUpdates();
    const { rerender } = render(<UpdateCaptionAction updates={updates}/>); await act(async () => {});
    act(() => api.handlers.get("app-update-caption-dismissed")?.({ payload: release.version }));
    expect(updates.dismissCaption).toHaveBeenCalledWith(release.version);
    rerender(<UpdateCaptionAction updates={{ ...updates, captionHidden: true }}/>);
    expect(api.invoke.mock.calls.filter(call => call[0] === "set_update_caption").at(-1)?.[1]).toMatchObject({ visible: false });
    expect(api.invoke).toHaveBeenCalledWith("set_tray_update", { stage: "ready", version: release.version, blocked: false });
    act(() => { api.handlers.get("app-update-tray-requested")?.({ payload: null }); });
    expect(screen.queryByRole("alertdialog")).toBeNull(); expect(updates.upgrade).toHaveBeenCalledOnce();
  });
  it("a tray click requests the complete update without another dialog", async () => {
    api.invoke.mockResolvedValue(undefined); const updates = readyUpdates();
    render(<UpdateCaptionAction updates={{ ...updates, stage: "available", progress: null }}/>); await act(async () => {});
    act(() => { api.handlers.get("app-update-tray-requested")?.({ payload: null }); });
    expect(updates.upgrade).toHaveBeenCalledOnce(); expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("keeps restart blocked for a tray event received during an interview", async () => {
    api.invoke.mockResolvedValue(undefined); const updates = { ...readyUpdates(), blockReason: "请先结束面试" };
    render(<UpdateCaptionAction updates={updates}/>); await act(async () => {});
    act(() => { api.handlers.get("app-update-tray-requested")?.({ payload: null }); });
    expect(screen.queryByRole("alertdialog")).toBeNull(); expect(updates.upgrade).not.toHaveBeenCalled();
    expect(api.invoke).toHaveBeenCalledWith("set_tray_update", { stage: "ready", version: release.version, blocked: true });
  });
  it("does not create native caption controls in browser preview", () => {
    const { container } = render(<UpdateCaptionAction updates={{ ...readyUpdates(), native: false }}/>);
    expect(container.innerHTML).toBe(""); expect(api.invoke).not.toHaveBeenCalled(); expect(api.listen).not.toHaveBeenCalled();
  });
});
