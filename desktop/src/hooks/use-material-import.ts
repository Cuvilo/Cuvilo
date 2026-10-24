import { useEffect, useRef, useState } from "react";
import {materialSection} from "@/lib/material-kinds";
import type { Material } from "@/types";

export type ImportItem = {
  id: string; path: string; name: string; kind?: string;
  status: "queued" | "reading" | "ready" | "read-error" | "saving" | "saved" | "save-error";
  material?: Material; error?: string;
};
const validationCache = new WeakMap<Material, string>();
export function materialValidation(material: Material) {
  const cached = validationCache.get(material);
  if (cached !== undefined) return cached;
  let error = "";
  if (!material.title.trim() || !material.text.trim()) error = "请填写标题和材料内容";
  else if ([...material.text].length > 100_000) error = "材料超过10万字，请精简后保存";
  validationCache.set(material, error);
  return error;
}

// Only transient review state. Existing extraction and save IPCs remain authoritative.
export function useMaterialImport(services: { read: (path: string) => Promise<string>; save: (material: Material) => Promise<unknown> }) {
  const [items, setItems] = useState<ImportItem[] | null>(null);
  const current = useRef<ImportItem[] | null>(null);
  const mounted = useRef(true), generation = useRef(0), saving = useRef(false);
  const latest = useRef(services); latest.current = services;
  const readTail = useRef(Promise.resolve());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const publish = (next: ImportItem[] | null) => {
    current.current = next;
    if (mounted.current) setItems(next);
  };
  const patch = (id: string, value: Partial<ImportItem>) => {
    if (current.current) publish(current.current.map(item => item.id === id ? { ...item, ...value } : item));
  };
  const read = (ids: string[], token: number) => {
    // A cancelled native extraction may finish, but cannot publish or start its remaining files.
    // New batches wait for that extraction so large PDFs are never extracted in parallel.
    readTail.current = readTail.current.then(async () => {
      for (const id of ids) {
        if (!mounted.current || token !== generation.current) return;
        const item = current.current?.find(item => item.id === id);
        if (!item || item.status !== "queued") continue;
        patch(id, { status: "reading", error: undefined });
        try {
          const text = await latest.current.read(item.path);
          if (!mounted.current || token !== generation.current) return;
          patch(id, { status: "ready", material: { id, title: item.name.replace(/\.[^.]+$/, ""), kind: item.kind ?? "resume", text, enabled: true, updatedAt: Date.now() } });
        } catch (error) {
          if (!mounted.current || token !== generation.current) return;
          patch(id, { status: "read-error", error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  };
  const start = (paths: string[], kind = "resume") => {
    if (!mounted.current || current.current || saving.current) return;
    const unique = [...new Map(paths.map(path => [path.replace(/\\/g, "/").toLowerCase(), path])).values()];
    const next: ImportItem[] = unique.map(path => ({ id: crypto.randomUUID(), path, kind, name: path.split(/[\\/]/).pop() || path,
      status: /\.(pdf|docx|txt|md)$/i.test(path) ? "queued" : "read-error",
      error: /\.(pdf|docx|txt|md)$/i.test(path) ? undefined : "支持 PDF、DOCX、TXT 和 Markdown 文件。" }));
    publish(next); read(next.filter(item => item.status === "queued").map(item => item.id), ++generation.current);
  };
  const close = () => { if (!saving.current) { generation.current++; publish(null); } };
  const update = (id: string, material: Material) => {
    const item = current.current?.find(item => item.id === id);
    if (!saving.current && item?.material && item.status !== "saved" && materialSection(material.kind)===materialSection(item.kind??"resume")) patch(id, { material, status: "ready", error: undefined });
  };
  const remove = (id: string) => { if (!saving.current && current.current) publish(current.current.filter(item => item.id !== id)); };
  const retry = (id: string) => {
    const item = current.current?.find(item => item.id === id);
    if (saving.current || item?.status !== "read-error" || !/\.(pdf|docx|txt|md)$/i.test(item.path)) return;
    patch(id, { status: "queued", error: undefined }); read([id], generation.current);
  };
  const save = async () => {
    if (saving.current || !current.current || current.current.some(item => ["queued", "reading"].includes(item.status))) return null;
    const candidates = current.current.filter(item => item.material && ["ready", "save-error"].includes(item.status) && !materialValidation(item.material));
    if (!candidates.length) return null;
    saving.current = true;
    const token = generation.current, saved: Material[] = [];
    try {
      for (const item of candidates) {
        if (!mounted.current || token !== generation.current) break;
        patch(item.id, { status: "saving", error: undefined });
        try {
          await latest.current.save(item.material!);
          saved.push(item.material!);
          if (!mounted.current || token !== generation.current) break;
          patch(item.id, { status: "saved" });
        } catch (error) {
          if (!mounted.current || token !== generation.current) break;
          patch(item.id, { status: "save-error", error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { saved, token, complete: !!current.current?.length && current.current.every(item => item.status === "saved") };
    } finally { saving.current = false; }
  };
  return { items, start, close, update, remove, retry, save, isOpen: () => current.current !== null, isCurrent: (token: number) => token === generation.current };
}
