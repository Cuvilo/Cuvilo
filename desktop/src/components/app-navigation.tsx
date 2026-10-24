import { FileText, History, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { TooltipHint } from "./ui/tooltip";
import { Button } from "./ui/button";

const navigation = [
  { id: "interview", label: "面试", accessible: "开始面试", icon: LayoutDashboard },
  { id: "materials", label: "个人材料", accessible: "个人材料", icon: FileText },
  { id: "history", label: "历史记录", accessible: "历史记录", icon: History },
  { id: "settings", label: "设置", accessible: "设置", icon: Settings2 },
] as const;

export function AppNavigation({ view, onNavigate, collapsed, onToggle }: {
  view: string;
  onNavigate: (view: typeof navigation[number]["id"]) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const navigateWithKey = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-navigation]"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus();
    onNavigate(navigation[next].id);
  };
  return <aside className="app-sidebar" aria-label="主导航">
      <nav className="sidebar-navigation" aria-label="页面" onKeyDown={navigateWithKey}>
        {navigation.map(({ id, label, accessible, icon: Icon }) => {
          const selected = view === id;
          return <TooltipHint key={id} label={label} side="right" enabled={collapsed}><Button variant="ghost" data-navigation={id}
            aria-current={selected ? "page" : undefined} aria-label={accessible}
            className={cn("navigation-item h-10 w-full rounded-lg px-0 text-sm", selected && "navigation-item-selected")}
            onClick={() => onNavigate(id)}>
            {selected && <span className="navigation-selection" aria-hidden="true" />}
            <span className="navigation-icon"><Icon className="size-5" /></span>
            <span className="sidebar-copy navigation-label" aria-hidden={collapsed}>{label}</span>
          </Button></TooltipHint>;
        })}
      </nav>
    <div className="sidebar-footer">
      <TooltipHint label={collapsed ? "展开侧栏" : "收起侧栏"} side="right"><Button variant="ghost" className="navigation-item sidebar-toggle h-10 w-full px-0 text-sm" aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        aria-expanded={!collapsed} onClick={onToggle}>
        <span className="navigation-icon sidebar-toggle-icons"><PanelLeftClose className="size-5 sidebar-icon-close" /><PanelLeftOpen className="size-5 sidebar-icon-open" /></span>
        <span className="sidebar-copy navigation-label" aria-hidden={collapsed}>收起侧栏</span>
      </Button></TooltipHint>
    </div>
  </aside>;
}
