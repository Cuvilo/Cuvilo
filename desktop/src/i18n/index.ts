import {useEffect, useLayoutEffect, useSyncExternalStore} from "react";
import {invoke} from "@tauri-apps/api/core";
import {english} from "./messages";

export type LanguagePreference = "system" | "zh-CN" | "en";
export type Locale = "zh-CN" | "en";
const cacheKey = "cuvilo.language";
const listeners = new Set<() => void>();
let locale: Locale = "zh-CN";
let nativeSystemLocale: string | undefined;
export function resolveLocale(preference: LanguagePreference, system = typeof navigator === "undefined" ? "zh-CN" : navigator.language): Locale {
  return preference === "system" ? /^zh(?:-|$)/i.test(system) ? "zh-CN" : "en" : preference;
}
export function setLanguage(preference: LanguagePreference, system?: string) {
  const next = resolveLocale(preference, system);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  for (const listener of listeners) listener();
}
export function currentLocale(): Locale { return locale; }
function subscribe(listener: () => void) { listeners.add(listener); return () => {listeners.delete(listener);}; }
export function useLocale() { return useSyncExternalStore(subscribe, currentLocale, currentLocale); }
export function t(source: string, ...values: (string | number | null | undefined)[]): string {
  const message = locale === "en" && Object.hasOwn(english,source) ? english[source] : source;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => index in values ? String(values[Number(index)] ?? "") : placeholder);
}
const patterns = Object.keys(english).filter(key => /\{\d+\}/.test(key)).map(key => {
  const parts = key.split(/(\{\d+\})/);
  const order: number[] = [];
  const pattern = parts.map(part => {
    const match = /^\{(\d+)\}$/.exec(part);
    if (match) {order.push(Number(match[1])); return "([\\s\\S]*?)";}
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return {key, order, pattern: new RegExp("^" + pattern + "$")};
});
// Only call this for app-owned messages, never transcript, model or material text.
export function messageText(source: string): string {
  if (locale !== "en" || Object.hasOwn(english,source)) return t(source);
  if(source.startsWith("Error: "))return "Error: "+messageText(source.slice(7));
  for (const {key, order, pattern} of patterns) {
    const match = pattern.exec(source);
    if (match) {
      const values: string[] = [];
      order.forEach((index, position) => {values[index] = match[position + 1];});
      return t(key, ...values);
    }
  }
  for (const prefix of Object.keys(english)) {
    for (const separator of [": ", "：", " · "]) {
      if (source.startsWith(prefix + separator)) return t(prefix) + separator + messageText(source.slice(prefix.length + separator.length));
    }
  }
  return source;
}
export function cachedLanguage(): LanguagePreference {
  try { const value = localStorage.getItem(cacheKey); if (value === "en" || value === "zh-CN") return value; } catch { /* Storage is optional. */ }
  return "system";
}
export function prepareLanguage() { setLanguage(cachedLanguage()); }
export function useAppLanguage(preference: LanguagePreference | undefined, loaded: boolean, native: boolean) {
  const selected = preference ?? "system";
  useLocale();
  useLayoutEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const update = () => {
      setLanguage(selected, native ? nativeSystemLocale : undefined);
      if (native && selected === "system") void invoke<string>("system_language_name").then(value => {
        if (!cancelled && (value === "en" || value === "zh-CN")) {nativeSystemLocale = value; setLanguage(selected, value);}
      }).catch(() => {});
    };
    update();
    try { localStorage.setItem(cacheKey, selected); } catch { /* Settings remain the source of truth. */ }
    window.addEventListener("languagechange", update);
    return () => {cancelled = true; window.removeEventListener("languagechange", update);};
  }, [selected, loaded, native]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (!native && event.key === cacheKey) setLanguage(cachedLanguage()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [native]);
}
