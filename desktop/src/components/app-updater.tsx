import {t as tr, useLocale, messageText} from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import type { AppUpdater } from "@/hooks/use-app-updater";
import { Button } from "./ui/button";
import { Spinner } from "./common";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";

function message(updates: AppUpdater) {
  switch (updates.stage) {
    case "checking": return tr("正在检查更新…");
    case "current": return tr("已是最新版本");
    case "available": return updates.blockReason === "请先结束面试" ? tr("发现 {0}，面试结束后可下载",updates.info?.version) : tr("发现新版本 {0}",updates.info?.version);
    case "downloading": return tr("正在下载 {0}{1}",updates.info?.version,updates.progress===null?"…":` · ${updates.progress}%`);
    case "ready": return tr("{0} 已就绪",updates.info?.version);
    case "installing": return tr("正在准备安装…");
    case "error": return messageText(updates.error);
    default: return tr("启动时自动检查更新");
  }
}
export function UpdateControls({ updates }: { updates: AppUpdater }) {
  useLocale();
  const [confirm, setConfirm] = useState(false);
  const waiting = ["checking", "downloading", "installing"].includes(updates.stage);
  return <>
    <div className="settings-option-row update-settings-row"><div><span className="update-status" role="status">{message(updates)}</span></div>
      {updates.stage === "ready" ? <Button size="sm" variant="primary" disabled={!updates.native || !!updates.blockReason} onClick={() => setConfirm(true)}><RefreshCw/>{tr("重启更新")}</Button>
        : <Button size="sm" variant="outline" disabled={!updates.native || waiting} onClick={() => void (updates.info && ["available", "error"].includes(updates.stage) ? updates.download() : updates.check())}>{waiting ? <Spinner/> : <RefreshCw/>}{updates.info && updates.stage === "available" ? tr("下载更新") : updates.info && updates.stage === "error" ? tr("重新下载") : tr("检查更新")}</Button>}
    </div>
    {updates.stage === "ready" && updates.blockReason && <p className="settings-footnote">{messageText(updates.blockReason)}</p>}
    <UpdateConfirmation updates={updates} open={confirm} onOpenChange={setConfirm}/>
  </>;
}
function UpdateConfirmation({ updates, open, onOpenChange }: { updates: AppUpdater; open: boolean; onOpenChange: (value: boolean) => void }) {
  useLocale();
  const installing = updates.stage === "installing";
  return <AlertDialog open={open} onOpenChange={value => { if (!installing) onOpenChange(value); }}><AlertDialogContent onEscapeKeyDown={event => { if (installing) event.preventDefault(); }}>
    <AlertDialogHeader><AlertDialogTitle>{tr("重启并更新到{0}？",updates.info?.version)}</AlertDialogTitle><AlertDialogDescription>{tr("安装后重新打开 Cuvilo，现有配置与面试记录会保留。")}</AlertDialogDescription></AlertDialogHeader>
    {updates.info?.notes && <p className="update-release-notes">{updates.info.notes}</p>}
    {(updates.error || updates.blockReason) && <p role="alert" className="settings-inline-error">{messageText(updates.error || updates.blockReason)}</p>}
    <AlertDialogFooter><AlertDialogCancel disabled={installing}>{tr("稍后")}</AlertDialogCancel><AlertDialogAction disabled={!updates.native || installing || !!updates.blockReason} onClick={event => { event.preventDefault(); void updates.install(); }}>{installing && <Spinner/>}{tr("重启更新")}</AlertDialogAction></AlertDialogFooter>
  </AlertDialogContent></AlertDialog>;
}
export function UpdateCaptionAction({ updates }: { updates: AppUpdater }) {
  const locale=useLocale();
  const [confirm, setConfirm] = useState(false);
  const [connected, setConnected] = useState(false);
  const current = useRef(updates); current.current = updates;
  useEffect(() => {
    if (!updates.native) return;
    let mounted = true;
    const cleanups: (() => void)[] = [];
    const subscribe = (name: string, handler: (event: { payload: unknown }) => void) => listen(name, handler).then(unlisten => {
      if (mounted) cleanups.push(unlisten); else unlisten();
    });
    void Promise.all([
      subscribe("app-update-install-requested", () => {
        if (!mounted) return;
        if (current.current.stage === "ready" && !current.current.blockReason) setConfirm(true);
        else if (current.current.stage === "available" || (current.current.stage === "error" && current.current.info)) void current.current.download();
      }),
      subscribe("app-update-caption-dismissed", event => {
        if (mounted && typeof event.payload === "string") current.current.dismissCaption(event.payload);
      }),
      subscribe("app-update-tray-requested", () => {
        if (mounted && !current.current.blockReason) void current.current.upgrade();
      }),
    ]).then(() => { if (mounted) setConnected(true); }).catch(() => {
      // Other entry points remain usable if a native listener cannot be registered.
      cleanups.splice(0).forEach(unlisten => unlisten());
    });
    return () => {
      mounted = false;
      cleanups.splice(0).forEach(unlisten => unlisten());
      void invoke("set_update_caption", { visible: false, enabled: false }).catch(() => {});
    };
  }, [updates.native]);
  useEffect(() => {
    if (!updates.native) return;
    void invoke("set_update_caption", {
      visible: connected && !updates.captionHidden && !!updates.info && ["available", "downloading", "ready", "installing", "error"].includes(updates.stage),
      enabled: connected && !updates.blockReason && ["available", "ready", "error"].includes(updates.stage),
      mode: updates.stage === "downloading" ? "downloading" : ["ready", "installing"].includes(updates.stage) ? "restart" : "download",
      progress: updates.progress,
      version: updates.info?.version ?? null,
      english: locale === "en",
    }).catch(() => {}); // The About page remains available on unsupported systems.
  }, [updates.native, updates.stage, updates.blockReason, updates.info, updates.progress, updates.captionHidden, connected, locale]);
  useEffect(() => {
    if (!updates.native) return;
    void invoke("set_tray_update", { stage: updates.stage, version: updates.info?.version ?? null, blocked: !!updates.blockReason }).catch(() => {});
  }, [updates.native, updates.stage, updates.info?.version, updates.blockReason]);
  return <UpdateConfirmation updates={updates} open={confirm} onOpenChange={setConfirm}/>;
}
