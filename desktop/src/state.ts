import {t as tr} from "./i18n";
import type { Answer, Transcript } from "./types";
export function mergeById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((x) => x.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((x, i) => (i === index ? item : x));
}
export function visibleAnswers(items: Answer[]): Answer[] {
  const latest = new Map<string, Answer>();
  for (const a of items) {
    const old = latest.get(a.questionId);
    if (
      !old ||
      a.revision > old.revision ||
      (a.revision === old.revision && a.createdAt >= old.createdAt)
    )
      latest.set(a.questionId, a);
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt);
}
export function questionTimeline(items: Answer[]): Answer[] {
  const firstSeen = new Map<string, number>();
  for (const answer of items) {
    firstSeen.set(answer.questionId, Math.min(firstSeen.get(answer.questionId) ?? Infinity, answer.createdAt));
  }
  return visibleAnswers(items).sort((a, b) => firstSeen.get(a.questionId)! - firstSeen.get(b.questionId)!);
}
export function transcriptDisplayText(text: string): string {
  return text.replace(/^[\s\u0085，,；;、：:？?。！!…]+/u, "");
}
export function visibleTranscripts(items: Transcript[]): Transcript[] {
  return items.flatMap(item => {
    const text = transcriptDisplayText(item.text);
    return text ? [{ ...item, text }] : [];
  });
}
export function transcriptLabel(t: Transcript) {
  return tr(t.source === "meeting" ? "会议" : "本人");
}
export function milliseconds(value: number | null | undefined) {
  return value == null ? "—" : `${(value / 1000).toFixed(2)}s`;
}
