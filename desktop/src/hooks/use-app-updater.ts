import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Copilot } from "./use-copilot";

type Stage = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
type UpdateInfo = { version: string; notes: string };
type Progress = { downloaded: number; total: number | null };
export type UpdateState = { stage: Stage; info: UpdateInfo | null; progress: number | null; error: string };
export function updateBlockReason(store: Pick<Copilot, "busy" | "data" | "settingsDirty" | "editing" | "materialImport">): string {
  if (store.data.session) return "请先结束面试";
  if (store.busy) return "请等待当前操作完成";
  if (store.settingsDirty) return "请先保存服务配置";
  if (store.editing || store.materialImport.isOpen()) return "请先保存或关闭材料编辑";
  return "";
}
const dismissalKey = "cuvilo.dismissed-update";
const blank: UpdateState = { stage: "idle", info: null, progress: null, error: "" };
export function useAppUpdater(store: Copilot, enabled = true) {
  const native = store.native && enabled;
  const [dismissedVersion, setDismissedVersion] = useState(() => {
    if (!native) return "";
    try { return localStorage.getItem(dismissalKey) || ""; } catch { return ""; }
  });
  const latest = useRef(store); latest.current = store;
  const alive = useRef(true), operation = useRef(false), checked = useRef(false);
  const [state, setState] = useState<UpdateState>(() => {
    const demo = !store.native && enabled ? new URLSearchParams(location.search).get("updateDemo") : null;
    return demo === "ready" || demo === "available" ? { ...blank, stage: demo, info: { version: "0.1.52", notes: "改进使用体验，修复已知问题。" } } : blank;
  });
  const current = useRef(state); current.current = state;
  const publish = useCallback((value: UpdateState) => { current.current = value; if (alive.current) setState(value); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = useCallback(async () => {
    if (!native || operation.current || current.current.stage === "ready") return;
    operation.current = true;
    publish({ ...blank, stage: "checking" });
    try {
      const info = await invoke<UpdateInfo | null>("check_app_update");
      publish({ ...blank, stage: info ? "available" : "current", info });
    } catch (error) { publish({ ...blank, stage: "error", error: String(error) }); }
    finally { operation.current = false; }
  }, [native, publish]);
  const dismissCaption = useCallback((version?: string) => {
    const target = version || current.current.info?.version;
    if (!target || target !== current.current.info?.version) return;
    setDismissedVersion(target);
    if (native) { try { localStorage.setItem(dismissalKey, target); } catch { /* Keep the choice for this run if storage is unavailable. */ } }
  }, [native]);
  const download = useCallback(async () => {
    if (!native || operation.current || latest.current.data.session || !current.current.info) return false;
    operation.current = true;
    publish({ ...current.current, stage: "downloading", error: "", progress: null });
    const progress = new Channel<Progress>();
    progress.onmessage = event => {
      if (current.current.stage !== "downloading") return;
      publish({ ...current.current, progress: event.total && event.total > 0 ? Math.min(99, Math.floor(event.downloaded / event.total * 100)) : null });
    };
    try {
      await invoke("download_app_update", { progress });
      publish({ ...current.current, stage: "ready", progress: 100 });
      return true;
    } catch (error) {
      const interrupted = String(error).includes("面试");
      publish({ ...current.current, stage: interrupted ? "available" : "error", progress: null, error: interrupted ? "" : String(error) });
      return false;
    } finally { operation.current = false; }
  }, [native, publish]);
  const install = useCallback(async () => {
    if (!native || operation.current || current.current.stage !== "ready") return false;
    const reason = updateBlockReason(latest.current);
    if (reason) { publish({ ...current.current, error: reason }); return false; }
    operation.current = true;
    publish({ ...current.current, stage: "installing", error: "" });
    try {
      if (!await latest.current.preferences.retry()) throw new Error("偏好设置未保存，请重试");
      const reason = updateBlockReason(latest.current);
      if (reason) throw new Error(reason);
      await invoke("install_app_update");
      return true;
    } catch (error) {
      publish({ ...current.current, stage: "ready", error: String(error) });
      return false;
    } finally { operation.current = false; }
  }, [native, publish]);
  // Clicking the tray's new version number authorizes the complete update flow.
  const upgrade = useCallback(async () => {
    if (!native || operation.current || updateBlockReason(latest.current)) return false;
    if (current.current.stage !== "ready") {
      if (!current.current.info || !["available", "error"].includes(current.current.stage)) return false;
      if (!await download()) return false;
    }
    // install rechecks live drafts/session state after the asynchronous download.
    return install();
  }, [native, download, install]);
  // One silent startup check; development/preview builds never contact the release service.
  useEffect(() => {
    if (!native || import.meta.env.DEV || !store.loaded || checked.current || store.data.session) return;
    const timer = setTimeout(() => { checked.current = true; void check(); }, 5000);
    return () => clearTimeout(timer);
  }, [native, store.loaded, !!store.data.session, check]);
  return { ...state, native, check, download, install, upgrade, dismissCaption, captionHidden: !!state.info && state.info.version === dismissedVersion, blockReason: updateBlockReason(store) };
}
export type AppUpdater = ReturnType<typeof useAppUpdater>;
