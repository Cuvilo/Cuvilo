import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import { useTheme } from "./hooks/use-theme";
import { useCopilot } from "./hooks/use-copilot";
import { useAppUpdater } from "./hooks/use-app-updater";
import { UpdateCaptionAction } from "./components/app-updater";
import { useScrollbarActivity } from "./hooks/use-scrollbar-activity";
import { cn } from "./lib/utils";
import { AppNavigation } from "./components/app-navigation";
import { TooltipProvider } from "./components/ui/tooltip";
import { AnswerWindow } from "./components/answer-window";
import { InterviewView } from "./components/interview-view";
import { SettingsView } from "./components/settings-view";
import { MaterialEditor, MaterialsView } from "./components/materials-view";
import { MaterialImportDialog } from "./components/material-import-dialog";
import { HistoryView } from "./components/history-view";
import { Notice, Toast } from "./components/common";

export default function App() {
  useScrollbarActivity();
  useEffect(()=>{
    const preventMenu=(event:MouseEvent)=>event.preventDefault();
    document.addEventListener("contextmenu",preventMenu);
    return ()=>document.removeEventListener("contextmenu",preventMenu);
  },[]);
  return <MotionConfig reducedMotion="user"><CopilotApp /></MotionConfig>;
}

function CopilotApp() {
  const store = useCopilot();
  const updates = useAppUpdater(store, new URLSearchParams(location.search).get("window") !== "answer");
  useTheme(store.data.settings.theme,store.loaded,store.native&&new URLSearchParams(location.search).get("window")!=="answer",store.native);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("interview-copilot.sidebar-collapsed") === "true"; } catch { return false; }
  });
  const toggleSidebar = () => setCollapsed((value) => {
    try { localStorage.setItem("interview-copilot.sidebar-collapsed", String(!value)); } catch { /* Layout remains usable if storage is unavailable. */ }
    return !value;
  });
  const overlay =
    new URLSearchParams(location.search).get("window") === "answer";
  if (overlay)
    return (
      <TooltipProvider>
        <AnswerWindow store={store} />
      </TooltipProvider>
    );
  return (
    <TooltipProvider>
      <div className={cn("app-layout", collapsed && "sidebar-collapsed")}>
        <AppNavigation view={store.view} onNavigate={view => { store.setView(view); if (view === "interview") store.setWorkspace("prepare"); }} collapsed={collapsed} onToggle={toggleSidebar} />
        <main className="app-main">
          <UpdateCaptionAction updates={updates}/>
          {store.data.warnings.length > 0 && <div className="app-warnings">
            {store.data.warnings.map((message) => (
              <Notice key={message}>{message}</Notice>
            ))}
          </div>}
            <div className={cn("page-content", store.view === "interview" && "workbench-page")}>
              {store.view === "interview" && <InterviewView store={store} />}
              {store.view === "materials" && <MaterialsView store={store} />}
              {store.view === "history" && <HistoryView store={store} />}
              {store.view === "settings" && <SettingsView store={store} updates={updates} />}
            </div>
        </main>
        <MaterialEditor store={store} />
        <MaterialImportDialog store={store} />
        <Toast notification={store.toast} onDismiss={store.dismissToast} />
      </div>
    </TooltipProvider>
  );
}
