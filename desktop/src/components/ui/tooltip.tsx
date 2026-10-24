import {useLocale} from "@/i18n";
import * as React from "react";
import { cn } from "@/lib/utils";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip as TooltipPrimitive } from "radix-ui";

const TooltipIntent = React.createContext<{
  keyboard: React.RefObject<boolean>;
  active: React.RefObject<boolean>;
  hoverReady: React.RefObject<boolean>;
  dismissed: number;
} | null>(null);

function TooltipProvider({
  delayDuration = 80,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  useLocale();
  const keyboard = React.useRef(false);
  const active = React.useRef(true);
  const hoverReady = React.useRef(true);
  const [dismissed, dismiss] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    let pointer: { x: number; y: number } | null = null;
    const key = (event: KeyboardEvent) => {
      if (!["Alt", "Control", "Shift", "Meta"].includes(event.key)) keyboard.current = true;
    };
    const down = () => { keyboard.current = false; };
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.x !== event.clientX || pointer.y !== event.clientY) hoverReady.current = true;
      pointer = { x: event.clientX, y: event.clientY };
    };
    const blur = () => {
      keyboard.current = false;
      active.current = false;
      hoverReady.current = false;
      dismiss();
    };
    const focus = () => { active.current = true; };
    const visibility = () => { if (document.hidden) blur(); else focus(); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().onFocusChanged(({ payload }) => payload ? focus() : blur()).then(stop => {
        if (disposed) stop(); else unlisten = stop;
      }).catch(() => { /* DOM focus and visibility listeners remain as a fallback. */ });
    }
    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    };
  }, []);
  return (
    <TooltipIntent.Provider value={{ keyboard, active, hoverReady, dismissed }}><TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={200}
      disableHoverableContent
      {...props}
    /></TooltipIntent.Provider>
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  useLocale();
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  useLocale();
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  useLocale();
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "tooltip-surface z-50 w-fit max-w-60 px-2 py-1 text-xs leading-[18px] [overflow-wrap:anywhere]",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

function TooltipHint({ label, children, side, enabled = true }: {
  label: string;
  children: React.ReactElement;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  enabled?: boolean;
}) {
  useLocale();
  const [open, setOpen] = React.useState(false);
  const intent = React.useContext(TooltipIntent);
  React.useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  React.useEffect(() => { setOpen(false); }, [intent?.dismissed]);
  return <Tooltip open={enabled && open} onOpenChange={next => {
    if (!next) setOpen(false);
    else if (enabled && (!intent || (intent.active.current && (intent.keyboard.current || intent.hoverReady.current)))) setOpen(true);
  }}>
    <TooltipTrigger asChild onFocus={event => { if (intent && !intent.keyboard.current) event.preventDefault(); }}>{children}</TooltipTrigger>
    <TooltipContent side={side}>{label}</TooltipContent>
  </Tooltip>;
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipHint };
