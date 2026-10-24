import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Checkbox({ className, indeterminate = false, ...props }: ComponentProps<"input"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-checked={indeterminate ? "mixed" : props.checked}
    className={cn("size-4 shrink-0 cursor-pointer rounded accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40", className)} {...props} />;
}
