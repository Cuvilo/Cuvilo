import { useEffect } from "react";

// Keep the existing scroll containers and refs: only annotate their visual activity.
export function useScrollbarActivity() {
  useEffect(() => {
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const element = event.target === document ? document.scrollingElement : event.target;
      if (!(element instanceof HTMLElement) ||
        (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth)) return;
      const previous = timers.get(element);
      if (previous !== undefined) clearTimeout(previous);
      element.dataset.scrollActive = "true";
      timers.set(element, setTimeout(() => {
        delete element.dataset.scrollActive;
        timers.delete(element);
      }, 800));
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      for (const [element, timer] of timers) {
        clearTimeout(timer);
        delete element.dataset.scrollActive;
      }
      timers.clear();
    };
  }, []);
}
