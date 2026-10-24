"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Tabs as TabsPrimitive } from "radix-ui";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "@/lib/motion";

const TabsValueContext = React.createContext<string | undefined>(undefined);
const TabsAnimationContext = React.createContext(true);

function Tabs({
  className,
  animated = true,
  orientation = "horizontal",
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & {animated?: boolean}) {
  const [internal, setInternal] = React.useState(defaultValue);
  const selected = value ?? internal;
  const id = React.useId();
  return (
    <TabsValueContext.Provider value={selected}><TabsAnimationContext.Provider value={animated}>
    <LayoutGroup id={id}>
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      value={selected}
      onValueChange={(next) => { setInternal(next); onValueChange?.(next); }}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
    </LayoutGroup>
    </TabsAnimationContext.Provider></TabsValueContext.Provider>
  );
}

const tabsListVariants = cva(
  "group/tabs-list isolate inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 border-b border-border bg-transparent px-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  value,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const selected = React.useContext(TabsValueContext) === value;
  const reduce = useReducedMotion();
  const animated = React.useContext(TabsAnimationContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "rounded-lg data-[state=active]:bg-transparent group-data-[variant=default]/tabs-list:data-[state=active]:text-foreground group-data-[variant=line]/tabs-list:data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none",
        className,
      )}
      {...props}
    >
      {selected && (animated ? <motion.span layoutId="selected-tab" aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-md bg-background shadow-sm group-data-[variant=line]/tabs-list:hidden"
        transition={reduce ? { duration: 0 } : motionTokens.navigation} /> : <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md bg-background shadow-sm"/>)}
      <span className="relative z-10 inline-flex items-center justify-center gap-2">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
