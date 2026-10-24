import {materialKinds as kinds,materialKindOptions,materialSection} from "@/lib/material-kinds";
import { useRef, useState } from "react";
import { Check, FileText, RotateCcw, X } from "lucide-react";
import type { Copilot } from "@/hooks/use-copilot";
import { materialValidation, type ImportItem } from "@/hooks/use-material-import";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field, IconButton, Spinner } from "./common";

const labels: Record<ImportItem["status"], string> = { queued: "等待读取", reading: "正在读取", ready: "待确认", "read-error": "读取失败", saving: "正在保存", saved: "已导入", "save-error": "保存失败" };


export function MaterialImportDialog({ store: s }: { store: Copilot }) {
  const batch = s.materialImport, items = batch.items ?? [];
  const [selected, setSelected] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const item = items.find(item => item.id === selected) ?? items[0];
  const saving = items.some(item => item.status === "saving");
  const reading = items.some(item => item.status === "reading" || item.status === "queued");
  const ready = items.filter(item => item.material && ["ready", "save-error"].includes(item.status) && !materialValidation(item.material)).length;
  const saved = items.filter(item => item.status === "saved").length;
  const failed = items.filter(item => item.status.endsWith("error") || (item.material && item.status !== "saved" && materialValidation(item.material))).length;
  const material = item?.material;
  const section=materialSection(item?.kind??"resume");
  const options=section==="knowledge"?[[material?.kind??"knowledge",kinds[material?.kind??"knowledge"]??"知识资料"]]:materialKindOptions(section);
  const locked = saving || item?.status === "saved";
  const error = item?.error || (material && item.status !== "saved" ? materialValidation(material) : "");
  return <Dialog open={!!batch.items} onOpenChange={open => { if (!open && !saving) batch.close(); }}>
    <DialogContent className="material-import-dialog" showCloseButton={!saving}
      onOpenAutoFocus={() => { trigger.current = document.activeElement as HTMLElement | null; }}
      onCloseAutoFocus={event => { event.preventDefault(); if (trigger.current?.isConnected) trigger.current.focus(); }}
      onEscapeKeyDown={event => { if (saving) event.preventDefault(); }}
      onPointerDownOutside={event => event.preventDefault()}>
      <DialogHeader className="border-b px-5 py-4 text-left">
        <DialogTitle>导入材料</DialogTitle>
        <DialogDescription className="text-xs">选择文件预览并调整，确认后统一保存。</DialogDescription>
      </DialogHeader>
      <div className="material-import-body">
        <div className="material-import-files" role="group" aria-label="待导入文件">
          <p className="mb-2 px-2 text-xs text-muted-foreground">文件 {items.length}</p>
          {items.map(file => <div key={file.id} className="material-import-file" data-selected={file.id === item?.id}>
            <button className="material-import-file-select" aria-pressed={file.id === item?.id} onClick={() => setSelected(file.id)}>
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0"><span className="material-import-filename">{file.name}</span>
                <span className={file.status.endsWith("error") ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{file.status === "ready" && file.material && materialValidation(file.material) ? "待修正" : labels[file.status]}</span></span>
              {file.status === "saved" && <Check className="ml-auto size-4 shrink-0" />}
            </button>
            {file.status !== "saved" && <IconButton label={`移除文件：${file.name}`} disabled={saving} onClick={() => batch.remove(file.id)}><X /></IconButton>}
          </div>)}
          {!items.length && <p className="px-2 text-xs text-muted-foreground">没有待导入文件</p>}
        </div>
        <div className="material-import-preview" aria-label="文件预览" aria-busy={item?.status === "reading"}>
          {material ? <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <Field id="import-title" label="材料标题"><Input id="import-title" value={material.title} disabled={locked} onChange={event => batch.update(item.id, { ...material, title: event.target.value })} /></Field>
              <Field id="import-kind" label="材料类型"><Select value={material.kind} disabled={locked} onValueChange={kind => batch.update(item.id, { ...material, kind })}>
                <SelectTrigger id="import-kind"><SelectValue /></SelectTrigger><SelectContent>{options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
              </Select></Field>
            </div>
            <Field id="import-text" label="材料内容" aside={<span className="text-xs font-normal text-muted-foreground">{[...material.text].length.toLocaleString()} 字</span>}>
              <Textarea id="import-text" className="material-import-text" value={material.text} disabled={locked} onChange={event => batch.update(item.id, { ...material, text: event.target.value })} />
            </Field>
          </> : <div className="material-import-placeholder">{reading && item && ["queued", "reading"].includes(item.status) ? <><Spinner /><span>{labels[item.status]}</span></> : <span>{item ? "无法预览此文件" : "选择文件后可预览内容"}</span>}</div>}
          {error && <div className="material-import-error"><p role="alert">{error}</p>{item.status === "read-error" && /\.(pdf|docx|txt|md)$/i.test(item.path) && <Button variant="outline" size="sm" disabled={saving} onClick={() => batch.retry(item.id)}><RotateCcw />重新读取</Button>}</div>}
        </div>
      </div>
      <DialogFooter className="material-import-footer">
        <p role="status" className="mr-auto text-xs text-muted-foreground">{reading ? "正在读取文件…" : saving ? "正在导入…" : `待确认 ${ready} 份`}{failed > 0 ? ` · 需处理 ${failed} 份` : ""}{saved > 0 ? ` · 已导入 ${saved} 份` : ""}</p>
        <Button variant="outline" disabled={saving} onClick={batch.close}>{saved ? "完成" : "取消"}</Button>
        <Button disabled={reading || saving || !ready} onClick={() => void s.saveImports()}>{saving ? <Spinner /> : <Check />}确认导入{ready ? `（${ready}）` : ""}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
