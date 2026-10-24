// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "./components/common";
import { AudioMeter } from "./components/interview-view";
import { useNotification } from "./hooks/use-notification";
import type { Copilot } from "./hooks/use-copilot";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, isTauri: () => false }));

function Harness() {
  const n = useNotification();
  const [savedId, saveId] = useState<number>();
  return <><button onClick={() => { n.notify("材料已保存", "success"); }}>成功</button>
    <button onClick={() => n.notify("预览信息")}>信息</button>
    <button onClick={() => n.notify("fixture operation failed", "error")}>失败</button>
    <button onClick={() => saveId(n.toast?.id)}>记住旧提示</button>
    <button onClick={() => n.dismissToast(savedId)}>迟到关闭</button>
    <Toast notification={n.toast} onDismiss={n.dismissToast} /></>;
}
const surface = () => document.querySelector<HTMLElement>(".toast-surface");
async function tick(ms: number) { await act(async () => { vi.advanceTimersByTime(ms); }); }
beforeEach(() => { vi.useFakeTimers(); api.invoke.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("compact notification interactions", () => {
  it.each([["成功", 2000, "success"], ["信息", 3000, "info"], ["失败", 6000, "error"]] as const)("expires %s after its own duration without stealing focus", async (label, duration, kind) => {
    render(<Harness />); const button = screen.getByRole("button", { name: label }); button.focus();
    fireEvent.click(button);
    expect(surface()?.dataset.kind).toBe(kind);
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("button", { name: "关闭提示" }) !== null).toBe(kind !== "success");
    await tick(duration - 1); expect(surface()).not.toBeNull();
    await tick(1); expect(surface()).toBeNull();
  });
  it("replaces repeated notifications and ignores a stale close", async () => {
    render(<Harness />); fireEvent.click(screen.getByText("成功"));
    fireEvent.click(screen.getByText("记住旧提示"));
    await tick(1700); fireEvent.click(screen.getByText("成功"));
    fireEvent.click(screen.getByText("迟到关闭"));
    expect(document.querySelectorAll(".toast-surface")).toHaveLength(1);
    await tick(1999); expect(surface()).not.toBeNull(); await tick(1); expect(surface()).toBeNull();
  });
  it("pauses on pointer hover and resumes the remaining duration", async () => {
    render(<Harness />); fireEvent.click(screen.getByText("成功")); await tick(1000);
    const viewport = document.querySelector(".toast-viewport")!;
    fireEvent.pointerMove(viewport); await tick(8000); expect(surface()).not.toBeNull();
    fireEvent.pointerLeave(viewport.parentElement!); await tick(999); expect(surface()).not.toBeNull();
    await tick(1); expect(surface()).toBeNull();
  });
  it("pauses while focused and supports Escape and explicit close", async () => {
    render(<Harness />); fireEvent.click(screen.getByText("失败")); await tick(500);
    const close = screen.getByRole("button", { name: "关闭提示" });
    act(() => close.focus()); await tick(10000); expect(surface()).not.toBeNull();
    fireEvent.keyDown(close, { key: "Escape" }); expect(surface()).toBeNull();
    fireEvent.click(screen.getByText("信息")); fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(surface()).toBeNull();
  });
  it("cleans up the notification timer on unmount", async () => {
    const view = render(<Harness />); fireEvent.click(screen.getByText("失败"));
    view.unmount(); expect(vi.getTimerCount()).toBe(0); await tick(10000);
  });
});

function audioStore(sourceId = "one") {
  return { levels: {}, sourceId, sources: [{ id: sourceId }], data: { session: null }, busy: "",
    action: async (_name: string, fn: () => Promise<unknown>) => { await fn(); },
    notify: vi.fn(),
  } as unknown as Copilot;
}
describe("audio test local feedback", () => {
  it("shows success locally for two seconds and clears it when the source changes", async () => {
    const store = audioStore(); const onPassed=vi.fn(); const view = render(<AudioMeter store={store} onPassed={onPassed}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "检测声音" })); });
    expect(screen.getByText("检测通过")).toBeTruthy(); expect(store.notify).not.toHaveBeenCalled();expect(onPassed).toHaveBeenCalledWith("one");
    await tick(1999); expect(screen.getByText("检测通过")).toBeTruthy();
    await tick(1); expect(screen.getByText("检测声音")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("检测声音")); });
    view.rerender(<AudioMeter store={audioStore("two")} />);
    expect(screen.queryByText("检测通过")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores late results after a source change or unmount", async () => {
    let finish!: () => void;
    api.invoke.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const onPassed=vi.fn();const view = render(<AudioMeter store={audioStore()} onPassed={onPassed}/>);
    fireEvent.click(screen.getByText("检测声音")); view.rerender(<AudioMeter store={audioStore("two")} onPassed={onPassed}/>);
    await act(async () => finish()); expect(screen.queryByText("检测通过")).toBeNull();expect(onPassed).not.toHaveBeenCalled();
    api.invoke.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByText("检测声音")); view.unmount();
    await act(async () => finish()); expect(vi.getTimerCount()).toBe(0);expect(onPassed).not.toHaveBeenCalled();
  });
});
