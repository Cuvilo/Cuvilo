import { describe, it, expect } from "vitest";
import { mergeById, visibleAnswers, questionTimeline, milliseconds } from "./state";
import type { Answer } from "./types";
const answer = (
  id: string,
  questionId: string,
  revision: number,
  createdAt: number,
): Answer => ({
  id,
  questionId,
  revision,
  createdAt,
  sessionId: "s",
  question: "问题",
  text: "答案",
  status: "complete",
  mode: "short",
  speechEndAt: 0,
  triggerAt: 0,
  requestAt: 0,
  firstTokenMs: null,
  firstSentenceMs: null,
});
describe("streaming state", () => {
  it("updates one answer without duplicating cards", () => {
    const list = [{ id: "a", text: "你" }];
    expect(mergeById(list, { id: "a", text: "你好" })).toEqual([
      { id: "a", text: "你好" },
    ]);
    expect(list[0].text).toBe("你");
  });
  it("shows newest revision while retaining independent questions", () => {
    const list = [
      answer("a", "q1", 1, 1),
      answer("b", "q1", 2, 2),
      answer("c", "q2", 1, 3),
    ];
    expect(visibleAnswers(list).map((a) => a.id)).toEqual(["b", "c"]);
  });
  it("reports meaningful missing metrics", () => {
    expect(milliseconds(null)).toBe("—");
    expect(milliseconds(1530)).toBe("1.53s");
  });
  it("keeps question order when an earlier question is regenerated or expanded", () => {
    const first = answer("a", "q1", 1, 1);
    const second = answer("b", "q2", 1, 2);
    const expanded = { ...answer("c", "q1", 1, 3), mode: "detail" };
    const revised = answer("d", "q2", 2, 4);
    expect(questionTimeline([first, second, expanded, revised]).map((item) => item.id)).toEqual(["c", "d"]);
  });
});
