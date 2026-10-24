import { BrandMark } from "./brand-mark";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { notificationDuration, type Notification } from "@/hooks/use-notification";
import { AudioLines, Check, CircleAlert, Info, LoaderCircle, X } from "lucide-react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import { TooltipHint } from "./ui/tooltip";
import { cn } from "@/lib/utils";

export function Spinner() {
  return <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />;
}
export function PageHeader({
  title,
  description,
  actions,
  leading,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <header className="page-header" aria-label={`${title}操作`}>
      <h1 className="sr-only">{title}</h1>
      {description && <p className="sr-only">{description}</p>}
      <div className="page-header-leading">{leading}</div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
export function Panel({
  title,
  description,
  icon,
  action,
  children,
  className,
  contentClassName,
  grouped = false,
}: {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  grouped?: boolean;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <Card className={cn("panel gap-0 py-0", grouped ? "rounded-2xl border shadow-[var(--shadow-card)]" : "border-0 shadow-none")}>
        {title && (
          <div className="panel-heading">
            <div>
              <h2 className="panel-title">
                {icon}
                {title}
              </h2>
              {description && (
                <p className="panel-description">{description}</p>
              )}
            </div>
            {action}
          </div>
        )}
        <div className={cn("panel-content", contentClassName)}>{children}</div>
      </Card>
    </section>
  );
}
export function Field({
  id,
  label,
  hint,
  aside,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <Label htmlFor={id} className="text-[13px]">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  icon: Icon = AudioLines,
  action,
  compact = false,
  brand = false,
}: {
  title: string;
  description?: string;
  icon?: typeof AudioLines;
  action?: ReactNode;
  compact?: boolean;
  brand?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-5 text-center",
        compact ? "min-h-56 py-8" : "min-h-72 py-12",
      )}
    >
      <div className={cn("empty-state-icon", brand && "empty-state-brand")} data-brand-empty={brand || undefined}>
        {brand ? <BrandMark className="size-10" /> : <Icon className="size-5" />}
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-2 max-w-72 text-xs leading-6 text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function IconButton({
  label,
  children,
  className,
  title,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <TooltipHint label={title ?? label}>
      <Button variant="ghost" size="icon-sm" aria-label={label}
        className={cn("shrink-0 text-muted-foreground", className)} {...props}>
        {children}
      </Button>
    </TooltipHint>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "primary" | "error";
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1.5 rounded-full px-2.5 py-1 font-normal",
        tone === "success" && "bg-success/9 text-success",
        tone === "primary" && "bg-primary/8 text-primary",
        tone === "error" && "bg-destructive/8 text-destructive",
      )}
    >
      <span
        className={cn(
          "status-dot",
          tone === "success" && "bg-success",
          tone === "primary" && "bg-primary",
          tone === "error" && "bg-destructive",
        )}
      />
      {children}
    </Badge>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Alert
      variant={error ? "destructive" : "default"}
      className={cn(
        "rounded-lg border-0 bg-surface-block",
        error && "bg-destructive/8",
      )}
    >
      <CircleAlert className="size-4" />
      <AlertDescription className="break-words text-xs leading-6 [overflow-wrap:anywhere]">
        {children}
      </AlertDescription>
    </Alert>
  );
}
export function Shortcut({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border bg-muted/60 px-1.5 py-0.5 font-sans text-[11px] leading-5 text-muted-foreground">
      {children}
    </kbd>
  );
}
export function Toast({ notification, onDismiss }: {
  notification: Notification | null;
  onDismiss: (id: number) => void;
}) {
  // Retain the content while Radix Presence plays the closing fade.
  const [displayed, setDisplayed] = useState(notification);
  useEffect(() => { if (notification) setDisplayed(notification); }, [notification]);
  const Icon = displayed?.kind === "error" ? CircleAlert : displayed?.kind === "success" ? Check : Info;
  return <ToastPrimitive.Provider label="操作提示" swipeDirection="right">
    {displayed && <ToastPrimitive.Root key={displayed.id}
      open={notification?.id === displayed.id}
      onOpenChange={open => { if (!open) onDismiss(displayed.id); }}
      duration={notificationDuration[displayed.kind]}
      type={displayed.kind === "error" ? "foreground" : "background"}
      className="toast-surface" data-kind={displayed.kind}>
      <Icon aria-hidden="true" className={cn("toast-icon", displayed.kind === "error" && "text-destructive")} />
      <ToastPrimitive.Description className="toast-message">{displayed.message}</ToastPrimitive.Description>
      {displayed.kind !== "success" && <ToastPrimitive.Close asChild>
        <Button variant="ghost" size="icon-xs" aria-label="关闭提示" className="toast-close"><X /></Button>
      </ToastPrimitive.Close>}
    </ToastPrimitive.Root>}
    <ToastPrimitive.Viewport className="toast-viewport" label="操作提示（{hotkey}）" />
  </ToastPrimitive.Provider>;
}
