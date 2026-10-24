import {t as tr, currentLocale, useLocale, messageText} from "@/i18n";
import { materialKinds as kinds, materialSection, materialKindOptions } from "@/lib/material-kinds";
import { useEffect, useRef, useState } from "react";
import {
  FileText,
  FolderOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
  Check,
  ListChecks,
} from "lucide-react";
import type { Copilot } from "@/hooks/use-copilot";
import type { Material } from "@/types";
import { TooltipHint } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Card } from "./ui/card";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { MaterialDropZone } from "./material-drop-zone";
import { EmptyState, Field, IconButton, PageHeader, Spinner } from "./common";

export function MaterialsView({ store: s }: { store: Copilot }) {
  useLocale();
  const [query, setQuery] = useState("");
  const section=s.materialSection;
  const defaultKind=section==="knowledge"?"knowledge":"resume";
  const sectionItems=s.data.materials.filter(m=>materialSection(m.kind)===section);
  const changeSection=(value:typeof section)=>{s.setMaterialSection(value);setSelected(new Set());setQuery("");};
  const [filter, setFilter] = useState("all");
  const [deleting, setDeleting] = useState<Material[] | null>(null);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState("");
  const list = useRef<HTMLDivElement | null>(null);
  const chosen = s.data.materials.filter(item => selected.has(item.id));
  useEffect(() => {
    setSelected(previous => {
      const next = new Set([...previous].filter(id => s.data.materials.some(item => item.id === id)));
      return next.size === previous.size ? previous : next;
    });
  }, [s.data.materials]);
  const toggleSelected = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const deleteTrigger = useRef<HTMLElement | null>(null);
  const items = sectionItems.filter((m) =>
    (filter !== "enabled" || m.enabled) && `${m.title}${m.text}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <MaterialDropZone store={s} onDropPaths={paths=>void s.importDropped(paths,defaultKind)}>
      <PageHeader
        title={tr("个人材料")}
        leading={s.data.materials.length > 0 ? (<div className="materials-search relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label={tr("搜索材料")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-card pl-9"
            placeholder={tr("搜索标题或内容…")}
          />
        </div>) : undefined}
        actions={
          <>
            {(s.data.materials.length > 0 || batch) && <Button variant={batch ? "secondary" : "outline"} disabled={!!s.busy || (!batch && !s.data.materials.length)} aria-pressed={batch}
              onClick={() => {setBatch(value => !value);setSelected(new Set());}}><ListChecks />{batch ? tr("完成") : tr("批量管理")}</Button>}
            <Button variant="outline" disabled={!!s.busy} onClick={() => void s.importDoc(defaultKind)}>
              <FolderOpen />
              {tr("导入文件")}</Button>
            <Button onClick={()=>s.newMaterial(section==="knowledge"?"knowledge":"project")}>
              <Plus />
              {tr("新建材料")}</Button>
          </>
        }
      />
      <div ref={list} tabIndex={-1} className="document-body outline-none">
      <div className="materials-section-toolbar">
        <div className="materials-filters" role="group" aria-label={tr("材料分类")}><Button size="sm" variant="ghost" aria-pressed={section==="personal"} onClick={()=>changeSection("personal")}>{tr("我的经历")}</Button><Button size="sm" variant="ghost" aria-pressed={section==="knowledge"} onClick={()=>changeSection("knowledge")}>{tr("知识资料")}</Button></div>
        <div className="materials-filters" role="group" aria-label={tr("筛选材料")}>
          <Button size="sm" variant="ghost" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>{tr("全部")}</Button>
          <Button size="sm" variant="ghost" aria-pressed={filter === "enabled"} onClick={() => setFilter("enabled")}>{tr("已启用")}</Button>
        </div>

      </div>
      {items.length ? (
        <div className={batch ? "materials-list materials-batch" : "materials-list"} role="table" aria-label={tr("个人材料列表")}>
          <div className="material-row material-row-header" role="row">{batch && <span role="columnheader" className="sr-only">{tr("选择")}</span>}<span role="columnheader">{tr("名称")}</span><span role="columnheader">{tr("类型")}</span>
            <span className="material-updated" role="columnheader">{tr("更新时间")}</span><span role="columnheader">{tr("用于回答")}</span>{!batch && <span role="columnheader">{tr("操作")}</span>}</div>
          {items.map(m => <div key={m.id} className="material-row" role="row">
            {batch && <div role="cell"><Checkbox aria-label={tr("选择材料：{0}", m.title)} checked={selected.has(m.id)} disabled={!!s.busy} onChange={() => toggleSelected(m.id)} /></div>}
            <div className="material-name" role="cell"><FileText /><TooltipHint label={m.title}><h2>{m.title}</h2></TooltipHint></div>
            <span className="material-kind" role="cell">{tr(kinds[m.kind] ?? m.kind)}</span>
            <time className="material-updated" role="cell" dateTime={new Date(m.updatedAt).toISOString()}>{new Date(m.updatedAt).toLocaleDateString(currentLocale(), {month:"2-digit",day:"2-digit"})}</time>
            <div className="material-toggle" role="cell"><Switch id={`material-${m.id}`} checked={m.enabled} disabled={!!s.busy} onCheckedChange={() => void s.toggleMaterial(m)} />
              <Label htmlFor={`material-${m.id}`}>{m.enabled ? tr("已启用") : tr("未启用")}</Label></div>
            {!batch && <div className="material-actions" role="cell"><IconButton label={tr("编辑材料：{0}", m.title)} onClick={() => s.setEditing({...m})}><Pencil /></IconButton>
              <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label={tr("删除材料：{0}", m.title)} disabled={!!s.busy}
                onClick={event => {deleteTrigger.current=event.currentTarget;setDeleteError("");setDeleting([m])}}><Trash2 />{tr("删除")}</Button></div>}
          </div>)}
        </div>
      ) : sectionItems.length > 0 ? (
        <Card className="gap-0 py-0 shadow-xs">
          <EmptyState title={query ? tr("没有匹配的材料") : tr("暂无启用材料")} description={query ? tr("试试其他关键词。") : undefined} icon={FileText} />
        </Card>
      ) : (
        <section className="materials-empty" aria-label={tr("导入材料")}>
          <Button variant="outline" disabled={!!s.busy} onClick={() => void s.importDoc(defaultKind)}><FolderOpen />{tr("导入材料")}</Button>
          <p className="materials-empty-formats">{section==="knowledge"?tr("文档、笔记、题库 · 按问题检索"):tr("简历、项目经历 · 个人背景")}</p><p className="materials-empty-formats">{tr("或拖入 PDF、DOCX、TXT、MD")}</p>
        </section>
      )}
      </div>
      {batch && <div className="material-batch-toolbar flex shrink-0 flex-wrap items-center gap-3 border-t bg-background px-6 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox aria-label={tr("全选当前材料")} disabled={!!s.busy || !items.length}
          checked={items.length > 0 && items.every(item => selected.has(item.id))}
          indeterminate={items.some(item => selected.has(item.id)) && !items.every(item => selected.has(item.id))}
          onChange={event => setSelected(previous => {const next = new Set(previous);for (const item of items) {if(event.target.checked) next.add(item.id);else next.delete(item.id);}return next;})} />{tr("全选当前结果")}</label>
        <span className="text-xs tabular-nums text-muted-foreground">{tr("已选")}{" "}{chosen.length}{" "}{tr("份")}</span>
        <Button variant="destructive" size="sm" className="ml-auto" disabled={!!s.busy || !chosen.length}
          onClick={event => {deleteTrigger.current=event.currentTarget;setDeleteError("");setDeleting(chosen)}}><Trash2 />{tr("删除所选")}{chosen.length ? `（${chosen.length}）` : ""}</Button>
      </div>}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) {setDeleting(null);setDeleteError("");}
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (deleteTrigger.current?.isConnected && !deleteTrigger.current.matches(":disabled"))
              deleteTrigger.current.focus();
            else list.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{deleting && deleting.length > 1 ? tr("删除这 {0} 份材料？", deleting.length) : tr("删除这份材料？")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.length === 1 ? `“${deleting[0].title}”` : tr("所选 {0} 份材料", deleting?.length ?? 0)}{tr("将从本地材料中移除，之后不再用于回答。已有会话记录会保留。")}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{messageText(deleteError)}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!s.busy}>{tr("取消")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive" disabled={!!s.busy}
              onClick={async event => {
                event.preventDefault();
                if (!deleting) return;
                const result = await s.deleteMaterial(batch ? deleting : deleting[0]);
                if (result.ok) {setDeleting(null);setSelected(new Set());}
                else setDeleteError(result.error);
              }}
            >
              {tr("删除材料")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MaterialDropZone>
  );
}
export function MaterialEditor({ store: s }: { store: Copilot }) {
  useLocale();
  const editing = s.editing;
  const trigger = useRef<HTMLElement | null>(null);
  const titleInput = useRef<HTMLInputElement | null>(null);
  return (
    <Dialog
      open={!!editing}
      onOpenChange={(open) => {
        if (!open) s.setEditing(null);
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          trigger.current = document.activeElement as HTMLElement | null;
          const input = titleInput.current;
          input?.focus({ preventScroll: true });
          if (input) input.setSelectionRange(input.value.length, input.value.length);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus();
        }}
      >
        <DialogHeader className="border-b px-6 py-5 text-left">
          <DialogTitle>{tr("确认材料内容")}</DialogTitle>
          <DialogDescription className="pt-1 text-xs">
            {editing&&materialSection(editing.kind)==="knowledge"?tr("按问题检索相关内容。"):tr("作为个人背景参考。")}
          </DialogDescription>
        </DialogHeader>
        {editing && (
          <>
            <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <Field id="material-title" label={tr("材料标题")}>
                  <Input
                    id="material-title"
                    ref={titleInput}
                    value={editing.title}
                    placeholder={materialSection(editing.kind)==="knowledge"?tr("例如：数据库笔记"):tr("例如：个人简历")}
                    onChange={(e) =>
                      s.setEditing({ ...editing, title: e.target.value })
                    }
                  />
                </Field>
                <Field id="material-kind" label={tr("材料类型")}>
                  <Select value={editing.kind} onValueChange={(value) => s.setEditing({ ...editing, kind: value })}>
                    <SelectTrigger id="material-kind"><SelectValue /></SelectTrigger>
                    <SelectContent>
                    {(materialSection(editing.kind)==="knowledge"?[[editing.kind,kinds[editing.kind]??tr("知识资料")]]:materialKindOptions("personal")).map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {name}
                      </SelectItem>
                    ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field
                id="material-text"
                label={tr("材料内容")}
                aside={
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {editing.text.length.toLocaleString()} {tr("字符")}</span>
                }
              >
                <Textarea
                  id="material-text"
                  className="min-h-60 resize-y leading-7"
                  value={editing.text}
                  placeholder={materialSection(editing.kind)==="knowledge"?tr("粘贴文档、笔记或题库内容。"):tr("粘贴简历、项目经历或岗位要求。")}
                  onChange={(e) =>
                    s.setEditing({ ...editing, text: e.target.value })
                  }
                />
              </Field>
            </div>
            <DialogFooter className="items-center gap-3 border-t bg-muted/25 px-6 py-4">
              <Button variant="outline" onClick={() => s.setEditing(null)}>
                {tr("取消")}</Button>
              <Button
                disabled={
                  !!s.busy || !editing.title.trim() || !editing.text.trim()
                }
                onClick={() => void s.saveMaterial()}
              >
                {s.busy === "material" ? <Spinner /> : <Check />}{tr("确认并保存")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
