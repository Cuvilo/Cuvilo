import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function BrandMark({ className, ...props }: ComponentProps<"img">) {
  return <img src="/brand/mark.svg"
    width={28} height={28} alt="" aria-hidden="true" draggable={false}
    className={cn("brand-mark size-7 shrink-0 object-contain", className)} {...props} />;
}
