// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleQuestion } from "./components/collapsible-question";
import { useAnswerFeed } from "./hooks/use-answer-feed";
import type { Answer } from "./types";

const question = "这是一个需要保留完整上下文的长问题。".repeat(12);
let textHeight: number;
let resize: (() => void)[];
let disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  textHeight = 132; resize = []; disconnect = vi.fn();
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function(this: Element) {
    return this.classList.contains("compact-question-text") ? textHeight : 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize.push(callback); }
    observe() {} disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compact question reading", () => {
  it("offers a keyboard accessible toggle only for overflowing questions", async () => {
    textHeight = 22;
    const keep = vi.fn(() => vi.fn());
    const view = render(<CollapsibleQuestion text="短问题" preserveAnchor={keep} />);
    expect(screen.queryByRole("button")).toBeNull();
    textHeight = 132; view.rerender(<CollapsibleQuestion text={question} preserveAnchor={keep} />);
    const toggle = screen.getByRole("button", { name: "展开完整问题" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(screen.getByRole("heading"));
    const user = userEvent.setup(); toggle.focus(); await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "收起完整问题" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
  it("preserves expansion during revisions but resets for a different question or session", () => {
    const keep = () => () => {};
    const view = render(<CollapsibleQuestion key="session-one:q1" text={question} preserveAnchor={keep} />);
    fireEvent.click(screen.getByRole("button", { name: "展开完整问题" }));
    view.rerender(<CollapsibleQuestion key="session-one:q1" text={question + "新的修订"} preserveAnchor={keep} />);
    expect(screen.getByRole("button", { name: "收起完整问题" })).toBeTruthy();
    view.rerender(<CollapsibleQuestion key="session-one:q2" text={question} preserveAnchor={keep} />);
    expect(screen.getByRole("button", { name: "展开完整问题" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开完整问题" }));
    view.rerender(<CollapsibleQuestion key="session-two:q2" text={question} preserveAnchor={keep} />);
    expect(screen.getByRole("button", { name: "展开完整问题" })).toBeTruthy();
  });
  it("remeasures when the window changes width and cleans up observers", () => {
    textHeight = 22;
    const view = render(<CollapsibleQuestion text={question} preserveAnchor={() => () => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    textHeight = 132; act(() => resize.forEach(callback => callback()));
    expect(screen.getByRole("button", { name: "展开完整问题" })).toBeTruthy();
    textHeight = 44; act(() => resize.forEach(callback => callback()));
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount(); expect(disconnect).toHaveBeenCalled();
  });
});

function ReadingHarness() {
  const [session, setSession] = useState("s1");
  const [answers, setAnswers] = useState([{questionId:"q1",question,text:"initial"} as Answer]);
  const feed = useAnswerFeed(answers, session);
  return <><button onClick={() => setAnswers(items => items.map(item => ({...item,text:item.text+" streamed"})))}>流式更新</button>
    <button onClick={() => setAnswers(items => [...items.filter(item => item.questionId !== "q2"), {questionId:"q2",question:"新问题",text:"next"} as Answer])}>新问题</button>
    <button onClick={() => setSession("s2")}>新会话</button>
    <main ref={feed.viewport} onScroll={feed.onScroll} data-testid="reading"><div ref={feed.content}>
      {answers.map(item => <CollapsibleQuestion key={`${session}:${item.questionId}`} text={item.question} preserveAnchor={feed.preserveAnchor} />)}
    </div></main>
    {feed.paused && <button onClick={feed.resume}>{feed.pending ? `${feed.pending} 条新问题` : "回到最新"}</button>}
  </>;
}
describe("explicit reading pause", () => {
  it("holds after expanding near the bottom, deduplicates new questions and resumes explicitly", () => {
    render(<ReadingHarness />);
    const viewport = screen.getByTestId("reading");
    Object.defineProperties(viewport, {scrollHeight:{configurable:true,value:1200},clientHeight:{configurable:true,value:400}});
    viewport.scrollTop = 800;
    fireEvent.click(screen.getByRole("button", {name:"展开完整问题"}));
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button",{name:"回到最新"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"流式更新"}));
    expect(viewport.scrollTop).toBe(800);
    expect(screen.getByRole("button",{name:"收起完整问题"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"新问题"}));
    fireEvent.click(screen.getByRole("button",{name:"新问题"}));
    expect(screen.getByRole("button",{name:"1 条新问题"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"1 条新问题"}));
    expect(screen.queryByRole("button",{name:"回到最新"})).toBeNull();
    expect(viewport.scrollTop).toBe(800);
  });
  it("retains automatic resume for ordinary scrolling and resets explicit pause for a new session", () => {
    render(<ReadingHarness />); const viewport = screen.getByTestId("reading");
    Object.defineProperties(viewport, {scrollHeight:{configurable:true,value:1200},clientHeight:{configurable:true,value:400}});
    viewport.scrollTop = 100; fireEvent.scroll(viewport);
    expect(screen.getByRole("button",{name:"回到最新"})).toBeTruthy();
    viewport.scrollTop = 800; fireEvent.scroll(viewport);
    expect(screen.queryByRole("button",{name:"回到最新"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"展开完整问题"}));
    fireEvent.click(screen.getByRole("button",{name:"新会话"}));
    expect(screen.queryByRole("button",{name:"回到最新"})).toBeNull();
    expect(screen.getByRole("button",{name:"展开完整问题"})).toBeTruthy();
    expect(viewport.scrollTop).toBe(800);
  });
});
