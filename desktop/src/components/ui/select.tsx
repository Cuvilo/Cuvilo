import type { ComponentProps } from "react";
import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = Primitive.Root;

export function SelectValue(props: ComponentProps<typeof Primitive.Value>) {
  return <Primitive.Value data-slot="select-value" {...props} />;
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger data-slot="select-trigger"
    className={cn("group/select flex h-9 w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-background px-3 text-left text-sm outline-none transition-[background-color,box-shadow] duration-150 hover:bg-surface-inset/70 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/70 data-[state=open]:bg-card data-[state=open]:ring-2 data-[state=open]:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate", className)} {...props}>
    {children}
    <Primitive.Icon asChild><ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/select:rotate-180" /></Primitive.Icon>
  </Primitive.Trigger>;
}

export function SelectContent({ className, children, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal>
    <Primitive.Content data-slot="select-content" position="popper" sideOffset={sideOffset} collisionPadding={12}
      className={cn("select-surface z-[60] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] overflow-hidden rounded-[14px] p-1.5 text-popover-foreground outline-none", className)} {...props}>
      <Primitive.ScrollUpButton className="flex h-5 items-center justify-center text-muted-foreground"><ChevronUp className="size-3.5" /></Primitive.ScrollUpButton>
      <Primitive.Viewport className="select-viewport">{children}</Primitive.Viewport>
      <Primitive.ScrollDownButton className="flex h-5 items-center justify-center text-muted-foreground"><ChevronDown className="size-3.5" /></Primitive.ScrollDownButton>
    </Primitive.Content>
  </Primitive.Portal>;
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="select-item"
    className={cn("relative flex min-h-9 cursor-pointer select-none items-center rounded-lg py-2 pl-3 pr-9 text-[13px] leading-5 outline-none [overflow-wrap:anywhere] data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-40", className)} {...props}>
    <Primitive.ItemText>{children}</Primitive.ItemText>
    <Primitive.ItemIndicator className="absolute right-3 flex size-4 items-center justify-center text-primary"><Check className="size-3.5" /></Primitive.ItemIndicator>
  </Primitive.Item>;
}
