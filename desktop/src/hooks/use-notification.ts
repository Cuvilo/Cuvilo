import { useCallback, useRef, useState } from "react";

export type NotificationKind = "success" | "info" | "error";
export type Notification = { id: number; kind: NotificationKind; message: string };
export const notificationDuration: Record<NotificationKind, number> = {
  success: 2000, info: 3000, error: 6000,
};

export function useNotification() {
  const [toast, setToast] = useState<Notification | null>(null);
  const sequence = useRef(0);
  const notify = useCallback((message: string, kind: NotificationKind = "info") => {
    setToast({ id: ++sequence.current, kind, message });
  }, []);
  // An old toast finishing its exit must never dismiss a newer notification.
  const dismissToast = useCallback((id?: number) => {
    setToast(current => id === undefined || current?.id === id ? null : current);
  }, []);
  return { toast, notify, dismissToast };
}
