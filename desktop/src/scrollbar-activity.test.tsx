// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollbarActivity } from "./hooks/use-scrollbar-activity";
function Harness() { useScrollbarActivity(); return <div data-testid="outer"><textarea data-testid="inner" /></div>; }
function scrollable(element: HTMLElement, horizontal = false) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: horizontal ? 100 : 1000 },
    clientHeight: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: horizontal ? 1000 : 100 },
    clientWidth: { configurable: true, value: 100 },
  });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("product scrollbar activity", () => {
  it("shows nested scrolling areas independently and restarts only the active timer", () => {
    render(<StrictMode><Harness /></StrictMode>);
    const outer = screen.getByTestId("outer"), inner = screen.getByTestId("inner");
    scrollable(outer); scrollable(inner); inner.scrollTop = 40;
    fireEvent.scroll(inner); expect(inner.dataset.scrollActive).toBe("true");
    expect(outer.dataset.scrollActive).toBeUndefined(); expect(inner.scrollTop).toBe(40);
    act(() => vi.advanceTimersByTime(500)); fireEvent.scroll(outer); fireEvent.scroll(inner);
    act(() => vi.advanceTimersByTime(799)); expect(inner.dataset.scrollActive).toBe("true");
    expect(outer.dataset.scrollActive).toBe("true");
    act(() => vi.advanceTimersByTime(1)); expect(inner.dataset.scrollActive).toBeUndefined();
    expect(outer.dataset.scrollActive).toBeUndefined();
  });
  it("handles horizontal scrolling and skips areas without overflow", () => {
    render(<Harness />); const outer = screen.getByTestId("outer"), inner = screen.getByTestId("inner");
    scrollable(inner, true); fireEvent.scroll(outer); expect(outer.dataset.scrollActive).toBeUndefined();
    fireEvent.scroll(inner); expect(inner.dataset.scrollActive).toBe("true");
    act(() => vi.advanceTimersByTime(800)); expect(inner.dataset.scrollActive).toBeUndefined();
  });
  it("clears timers, attributes and the listener on unmount", () => {
    const view = render(<Harness />); const inner = screen.getByTestId("inner"); scrollable(inner);
    fireEvent.scroll(inner); expect(vi.getTimerCount()).toBe(1);
    view.unmount(); expect(inner.dataset.scrollActive).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    document.body.append(inner); fireEvent.scroll(inner); expect(inner.dataset.scrollActive).toBeUndefined(); inner.remove();
  });
});
