// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMaterialImport, materialValidation } from "./hooks/use-material-import";
import type { Material } from "./types";

afterEach(cleanup);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (text = "content"): Material => ({ id: "fixture", title: "title", text, kind: "project", enabled: true, updatedAt: 1 });

describe("confirmed material batches", () => {
  it("reads files sequentially, deduplicates Windows paths, and requires explicit save", async () => {
    const first = deferred<string>(), read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("second content"), save = vi.fn();
    const { result } = renderHook(() => useMaterialImport({ read, save }));
    act(() => result.current.start(["C:/fixture/A.TXT", "c:\\fixture\\a.txt", "C:/fixture/b.md"]));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(result.current.items).toHaveLength(2);
    await act(async () => { expect(await result.current.save()).toBeNull(); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => first.resolve("first content"));
    await waitFor(() => expect(result.current.items?.every(item => item.status === "ready")).toBe(true));
    expect(read).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
    const second = result.current.items![1];
    act(() => result.current.update(second.id, { ...second.material!, kind: "project", title: "edited", text: "corrected" }));
    let outcome: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome!.complete).toBe(true); expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ title: "edited", kind: "project", text: "corrected" });
  });
  it("keeps mixed file errors local, continues reading, and retries just the failed extraction", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("fixture damaged PDF")).mockResolvedValue("fixture text"), save = vi.fn();
    const { result } = renderHook(() => useMaterialImport({ read, save }));
    act(() => result.current.start(["a.pdf", "invalid.exe", "b.txt"]));
    await waitFor(() => expect(result.current.items?.map(item => item.status)).toEqual(["read-error", "read-error", "ready"]));
    expect(read).toHaveBeenCalledTimes(2);
    act(() => result.current.retry(result.current.items![1].id)); expect(read).toHaveBeenCalledTimes(2);
    act(() => result.current.retry(result.current.items![0].id));
    await waitFor(() => expect(result.current.items![0].status).toBe("ready"));
    expect(read.mock.calls.map(args => args[0])).toEqual(["a.pdf", "b.txt", "a.pdf"]);
    expect(save).not.toHaveBeenCalled();
  });
  it("preserves failed saves and stable IDs, skips saved items and prevents overlapping submissions", async () => {
    const pending = deferred<void>(), save = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("fixture disk failure")).mockResolvedValue(undefined);
    const { result } = renderHook(() => useMaterialImport({ read: vi.fn().mockResolvedValue("fixture text"), save }));
    act(() => result.current.start(["a.txt", "b.md", "c.docx"]));
    await waitFor(() => expect(result.current.items?.every(item => item.status === "ready")).toBe(true));
    const ids = result.current.items!.map(item => item.id);
    let saving!: ReturnType<typeof result.current.save>;
    act(() => { saving = result.current.save(); });
    await act(async () => { expect(await result.current.save()).toBeNull(); result.current.close(); result.current.remove(ids[0]); });
    expect(result.current.items).toHaveLength(3);
    await act(async () => { pending.resolve(); await saving; });
    expect(result.current.items?.map(item => item.status)).toEqual(["saved", "save-error", "saved"]);
    await act(async () => { await result.current.save(); });
    expect(save.mock.calls.map(args => args[0].id)).toEqual([ids[0], ids[1], ids[2], ids[1]]);
    expect(result.current.items?.every(item => item.status === "saved")).toBe(true);
  });
  it("discards cancelled results and queued work, allowing a fresh batch after an in-flight read", async () => {
    const first = deferred<string>(), read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("fresh content");
    const { result } = renderHook(() => useMaterialImport({ read, save: vi.fn() }));
    act(() => result.current.start(["old-a.txt", "old-b.txt"]));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => { result.current.close(); result.current.start(["new-a.txt", "new-b.md"]); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve("discarded content"));
    await waitFor(() => expect(result.current.items?.every(item => item.status === "ready")).toBe(true));
    expect(read.mock.calls.map(args => args[0])).toEqual(["old-a.txt", "new-a.txt", "new-b.md"]);
    expect(result.current.items?.every(item => item.material?.text === "fresh content")).toBe(true);
  });
  it("stops queued extraction on unmount and cannot overwrite an open batch", async () => {
    const first = deferred<string>(), read = vi.fn().mockReturnValue(first.promise);
    const { result, unmount } = renderHook(() => useMaterialImport({ read, save: vi.fn() }));
    act(() => { result.current.start(["a.txt", "b.md"]); result.current.start(["replacement.txt"]); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(result.current.items!.map(item => item.name)).toEqual(["a.txt", "b.md"]);
    unmount(); await act(async () => first.resolve("late result"));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("allows invalid extracted text to be corrected without saving invalid or removed files", async () => {
    const save = vi.fn(), { result } = renderHook(() => useMaterialImport({ read: vi.fn().mockResolvedValue(""), save }));
    act(() => result.current.start(["empty.txt", "remove.md"]));
    await waitFor(() => expect(result.current.items?.every(item => item.status === "ready")).toBe(true));
    await act(async () => { expect(await result.current.save()).toBeNull(); });
    const [first, second] = result.current.items!;
    act(() => { result.current.remove(second.id); result.current.update(first.id, { ...first.material!, text: "corrected" }); });
    await act(async () => { await result.current.save(); });
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][0].id).toBe(first.id);
    // Match Rust Unicode scalar counting, not UTF-16 code units.
    expect(materialValidation(fixture("😀".repeat(100_000)))).toBe("");
    expect(materialValidation(fixture("字".repeat(100_001)))).toContain("10万字");
  });
});


it("preserves the selected knowledge import role across cancellation and retry",async()=>{
 const read=vi.fn().mockRejectedValueOnce(new Error("fixture read error")).mockResolvedValue("knowledge text"),save=vi.fn();
 const {result}=renderHook(()=>useMaterialImport({read,save}));act(()=>result.current.start(["notes.md","manual.txt"],"knowledge"));await waitFor(()=>expect(result.current.items?.[1].status).toBe("ready"));act(()=>result.current.retry(result.current.items![0].id));await waitFor(()=>expect(result.current.items?.every(i=>i.material?.kind==="knowledge")).toBe(true));expect(save).not.toHaveBeenCalled();
 await act(async()=>{await result.current.save();});expect(save.mock.calls.every(([m])=>m.kind==="knowledge")).toBe(true);
});

it("keeps imports in their originating section even after a review or delayed retry",async()=>{
 const save=vi.fn();const {result}=renderHook(()=>useMaterialImport({read:async()=>"fixture knowledge",save}));
 act(()=>result.current.start(["notes.md"],"knowledge"));await waitFor(()=>expect(result.current.items?.[0].status).toBe("ready"));const item=result.current.items![0];
 act(()=>result.current.update(item.id,{...item.material!,kind:"resume",title:"wrong section"}));expect(result.current.items![0].material!.kind).toBe("knowledge");
 await act(async()=>{await result.current.save();});expect(save.mock.calls[0][0].kind).toBe("knowledge");
});
