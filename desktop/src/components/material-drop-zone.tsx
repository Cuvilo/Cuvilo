import {t as tr, useLocale} from "@/i18n";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FolderOpen } from "lucide-react";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { Copilot } from "@/hooks/use-copilot";
import { materialDropError } from "@/lib/material-import";
import { cn } from "@/lib/utils";

export function MaterialDropZone({ store, children, className, onDropPaths, disabled = false }: { store: Copilot; children: ReactNode; className?: string; onDropPaths?: (paths: string[]) => void; disabled?: boolean }) {
  useLocale();
  const zone = useRef<HTMLDivElement>(null);
  const latest = useRef({ store, onDropPaths, disabled });
  latest.current = { store, onDropPaths, disabled };
  const [hovering, setHovering] = useState(false);
  const available = () => {
    const s = latest.current.store;
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1);
    return !latest.current.disabled && !s.busy && !s.editing && !s.materialImport.items && (!dialog || dialog.contains(zone.current));
  };
  const accept = (paths: string[]) => {
    const error = materialDropError(paths);
    if (error) { latest.current.store.notify(error, "error"); return; }
    if (latest.current.onDropPaths) latest.current.onDropPaths(paths);
    else void latest.current.store.importDropped(paths);
  };
  useEffect(() => {
    if (!store.native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = ({ payload }: { payload: DragDropEvent }) => {
      if (disposed) return;
      if (payload.type === "leave") { setHovering(false); return; }
      const rect = zone.current?.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const x = payload.position.x / ratio, y = payload.position.y / ratio;
      const inside = !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom && available();
      setHovering(payload.type !== "drop" && inside);
      if (payload.type === "drop" && inside) accept(payload.paths);
    };
    void getCurrentWebview().onDragDropEvent(receive).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {
      if (!disposed) latest.current.store.notify("拖入功能暂不可用，请使用导入文件按钮。", "error");
    });
    return () => { disposed = true; unlisten?.(); };
  }, [store.native]);
  useEffect(() => { if (disabled || store.busy || store.editing || store.materialImport.items) setHovering(false); }, [disabled, store.busy, store.editing, store.materialImport.items]);
  const dragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (!store.native && available()) { event.dataTransfer.dropEffect = "copy"; setHovering(true); }
  };
  return <div ref={zone} className={cn("material-drop-zone", className)} onDragEnter={dragOver} onDragOver={dragOver}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovering(false); }}
    onDrop={event => {
      event.preventDefault(); setHovering(false);
      if (store.native || !available()) return;
      const names = Array.from(event.dataTransfer.files).map(file => file.name);
      const error = materialDropError(names);
      store.notify(error ?? "当前是界面预览，请在桌面客户端中拖入材料。", error ? "error" : "info");
    }}>
    {children}
    {hovering && <div className="material-drop-overlay" role="status"><FolderOpen aria-hidden="true" /><strong>{tr("松开以导入文件")}</strong></div>}
  </div>;
}
