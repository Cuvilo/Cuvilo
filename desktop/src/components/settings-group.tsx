import type { ComponentProps } from "react";
import { Panel } from "./common";
import { cn } from "@/lib/utils";

export function SettingsGroup({ className, ...props }: ComponentProps<typeof Panel>) {
  return <Panel {...props} grouped className={cn("settings-group", className)} />;
}
