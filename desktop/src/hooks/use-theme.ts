import {invoke} from "@tauri-apps/api/core";
import {useLayoutEffect,useRef} from "react";
import type {Settings} from "@/types";
const key="cuvilo.theme";
function isDark(theme:Settings["theme"]){
 return theme==="dark"||(theme==="system"&&typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: dark)").matches);
}
function applyDark(dark:boolean){
 document.documentElement.classList.toggle("dark",dark);
 document.documentElement.style.colorScheme=dark?"dark":"light";
}
// A theme change already has one document transition. Do not start a second,
// delayed color transition on each control inside the newly captured palette.
function settleColors(){
 if(typeof CSSTransition==="undefined"||typeof document.getAnimations!=="function")return;
 for(const animation of document.getAnimations()){
  if(animation instanceof CSSTransition&&/^(color|background-color|border(-.+)?-color|outline-color|box-shadow|text-shadow|fill|stroke|filter)$/.test(animation.transitionProperty)){
   try{animation.finish();}catch{/* An already cancelled transition needs no work. */}
  }
 }
}
function themeController(nativeMain:boolean,nativeWindow:boolean){
 let initialized=false,disposed=false,desired=false,generation=0,resolution=0;
 let lastNativePreference:Settings["theme"]|null=null;
 let active:ViewTransition|null=null;
 let preference:Settings["theme"]="light";
 const native=(startedAtMs?:number,theme=preference,dark=desired)=>{lastNativePreference=theme;if(nativeMain)void invoke("preview_theme",{theme,resolvedDark:dark,startedAtMs:startedAtMs??null}).catch(()=>{/* The normal preference save retries the native appearance. */});};
 const root=document.documentElement;
 const commit=(dark:boolean)=>{applyDark(dark);settleColors();};
 const stop=()=>{generation++;active?.skipTransition();active=null;root.removeAttribute("data-theme-transition");};
 const startAnimations=(start:number)=>{
  root.dataset.themeTransition="true";
  for(const animation of document.getAnimations?.()??[]){
   if(typeof KeyframeEffect!=="undefined"&&animation.effect instanceof KeyframeEffect&&animation.effect.pseudoElement?.startsWith("::view-transition-")){
    animation.play();animation.startTime=start-performance.timeOrigin;
   }
  }
 };
 const run=()=>{
  if(disposed||active)return;
  if(root.classList.contains("dark")===desired){if(lastNativePreference!==preference)native();return;}
  const target=desired,chosen=preference,ticket=++generation;
  root.dataset.themeTransition="preparing";
  try{
   const transition=document.startViewTransition(()=>{if(!disposed&&generation===ticket)commit(target);});
   active=transition;
   void transition.ready.then(async()=>{
    if(disposed||generation!==ticket)return;
    // Keep the old palette visible while native preparation crosses IPC. Both
    // surfaces then use one future clock, rather than racing the first frame.
    let start=Date.now();
    if(nativeMain){lastNativePreference=chosen;start=await invoke<number>("prepare_theme_transition",{theme:chosen,resolvedDark:target});}
    if(disposed||generation!==ticket)return;
    startAnimations(Number.isFinite(start)?start:Date.now());
   }).catch(()=>{if(!disposed&&generation===ticket){startAnimations(Date.now());native(undefined,chosen,target);}});
   void transition.finished.catch(()=>{}).then(()=>{
    if(disposed||active!==transition)return;
    active=null;root.removeAttribute("data-theme-transition");
    // Coalesce rapid toggles. Starting another transition early would force the
    // browser to jump the current fade to its end before capturing the next one.
    run();
   });
  }catch{stop();commit(desired);native();}
 };
 return {
  update(theme:Settings["theme"]){
   preference=theme;const request=++resolution;
   const resolved=(dark:boolean)=>{
    if(disposed||request!==resolution)return;
    desired=dark;
    const reduced=typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(!initialized||reduced||typeof document.startViewTransition!=="function"||document.visibilityState==="hidden"){
     stop();commit(desired);if(initialized)native();else lastNativePreference=theme;
    }else run();
    initialized=true;
   };
   // WebView2's media query reflects a forced window theme. Resolve the OS
   // separately before capturing either palette when returning to system mode.
   if(theme==="system"&&nativeWindow){void invoke<boolean>("system_theme_dark").then(dark=>resolved(typeof dark==="boolean"?dark:isDark(theme))).catch(()=>resolved(isDark(theme)));}
   else resolved(isDark(theme));
  },
  dispose(){disposed=true;stop();},
 };
}
export function prepareTheme(){try{const saved=localStorage.getItem(key);applyDark(isDark(saved==="dark"||saved==="system"?saved:"light"));}catch{applyDark(false);}}
export function useTheme(theme:Settings["theme"],loaded:boolean,nativeMain=false,nativeWindow=nativeMain){
 const controller=useRef<ReturnType<typeof themeController>|null>(null);
 useLayoutEffect(()=>{
  const current=themeController(nativeMain,nativeWindow);controller.current=current;
  return()=>{current.dispose();controller.current=null;};
 },[nativeMain,nativeWindow]);
 useLayoutEffect(()=>{
  if(!loaded)return;
  const chosen=theme??"light",update=()=>controller.current?.update(chosen);
  update();
  try{localStorage.setItem(key,chosen);}catch{/* Theme remains usable without a cache. */}
  if(chosen!=="system"||typeof matchMedia!=="function")return;
  const media=matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change",update);
  return()=>media.removeEventListener("change",update);
 },[theme,loaded]);
}
