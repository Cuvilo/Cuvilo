import type { ComponentProps } from "react";
import { DropdownMenu as Primitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuLabel = Primitive.Label;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal>
    <Primitive.Content sideOffset={sideOffset} collisionPadding={8} align="end"
      className={cn("menu-surface z-50 min-w-44 max-w-[calc(100vw-16px)] rounded-[14px] p-1.5 text-popover-foreground outline-none", className)} {...props} />
  </Primitive.Portal>;
}
const itemStyle = "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-[13px] leading-5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={cn(itemStyle, className)} {...props} />;
}
export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Primitive.CheckboxItem>) {
  return <Primitive.CheckboxItem className={cn(itemStyle, "pl-8", className)} {...props}>
    <span className="absolute left-2.5"><Primitive.ItemIndicator><Check /></Primitive.ItemIndicator></span>{children}
  </Primitive.CheckboxItem>;
}
export function DropdownMenuSeparator(props: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className="my-1 h-px bg-border/60" {...props} />;
}
