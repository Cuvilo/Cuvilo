// @vitest-environment jsdom
import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {useAutostart} from "./hooks/use-autostart";
import {prepareTheme,useTheme} from "./hooks/use-theme";
const api=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
beforeEach(()=>{api.invoke.mockReset();localStorage.clear();document.documentElement.className="";document.documentElement.style.colorScheme="";});afterEach(()=>{cleanup();vi.restoreAllMocks();Reflect.deleteProperty(document,"startViewTransition");Reflect.deleteProperty(document,"getAnimations");vi.useRealTimers();vi.unstubAllGlobals();document.documentElement.className="";document.documentElement.style.colorScheme="";});
describe("general preferences",()=>{
 it("reads startup state and only writes after the explicit toggle, preserving its state on failure",async()=>{
  api.invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("fixture registry failure")).mockResolvedValueOnce(true);const{result}=renderHook(()=>useAutostart(true));await waitFor(()=>expect(result.current.loaded).toBe(true));expect(api.invoke).toHaveBeenCalledTimes(1);
  await act(async()=>result.current.change(true));expect(result.current.enabled).toBe(false);expect(result.current.error).toContain("fixture registry failure");await act(async()=>result.current.change(true));expect(result.current.enabled).toBe(true);expect(result.current.error).toBe("");expect(api.invoke.mock.calls[1]).toEqual(["set_autostart",{enabled:true}]);
 });
 it("can retry an unreadable startup setting and ignores a result after unmount",async()=>{
  api.invoke.mockRejectedValueOnce(new Error("fixture read failure")).mockResolvedValueOnce(true);const{result,unmount}=renderHook(()=>useAutostart(true));await waitFor(()=>expect(result.current.error).toContain("fixture read failure"));expect(result.current.loaded).toBe(false);await act(async()=>result.current.retry());expect(result.current.enabled).toBe(true);unmount();
 });
 it("keeps browser preview startup changes out of the operating system",async()=>{const{result}=renderHook(()=>useAutostart(false));await act(async()=>result.current.change(true));expect(result.current.enabled).toBe(true);expect(api.invoke).not.toHaveBeenCalled();});
 it("applies saved and system themes to the document and cleans up the system listener",()=>{
  let dark=true;const listeners=new Set<()=>void>();const media={get matches(){return dark},addEventListener:vi.fn((_:string,fn:()=>void)=>listeners.add(fn)),removeEventListener:vi.fn((_:string,fn:()=>void)=>listeners.delete(fn))};vi.stubGlobal("matchMedia",()=>media);
  const{rerender,unmount}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"system" as "system"|"light"|"dark"}});expect(document.documentElement.classList.contains("dark")).toBe(true);dark=false;act(()=>listeners.forEach(fn=>fn()));expect(document.documentElement.classList.contains("dark")).toBe(false);
  rerender({theme:"dark"});expect(document.documentElement.style.colorScheme).toBe("dark");expect(listeners.size).toBe(0);rerender({theme:"light"});expect(document.documentElement.classList.contains("dark")).toBe(false);unmount();expect(listeners.size).toBe(0);
 });
 it("restores only the theme cache before rendering and waits for the native snapshot before replacing it",()=>{
  localStorage.setItem("cuvilo.theme","dark");prepareTheme();const{rerender}=renderHook(({loaded})=>useTheme("light",loaded),{initialProps:{loaded:false}});expect(document.documentElement.classList.contains("dark")).toBe(true);rerender({loaded:true});expect(document.documentElement.classList.contains("dark")).toBe(false);
 });
});


function transitionFixture(){
 const jobs:Array<{commit:()=>void,finish:()=>void,skip:ReturnType<typeof vi.fn>}>=[];
 const start=vi.fn((commit:()=>void)=>{
  let finish!:()=>void;
  const finished=new Promise<void>(resolve=>{finish=resolve;});
  const skip=vi.fn(finish);jobs.push({commit,finish,skip});
  return {ready:Promise.resolve(),finished,skipTransition:skip};
 });
 Object.defineProperty(document,"startViewTransition",{configurable:true,value:start});
 vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
 vi.stubGlobal("matchMedia",()=>({matches:false}));
 return {jobs,start};
}
describe("theme transition lifecycle",()=>{
 it("skips startup animation and composites one complete palette for a later change",async()=>{
  const{jobs,start}=transitionFixture();
  const{rerender}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});
  expect(start).not.toHaveBeenCalled();rerender({theme:"dark"});expect(start).toHaveBeenCalledTimes(1);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  act(()=>jobs[0].commit());expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(true);
  await act(async()=>jobs[0].finish());expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
 });
 it("coalesces rapid toggles rather than forcing an active crossfade to jump",async()=>{
  const{jobs,start}=transitionFixture();
  const{rerender}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});
  rerender({theme:"dark"});act(()=>jobs[0].commit());rerender({theme:"light"});rerender({theme:"dark"});rerender({theme:"light"});
  expect(start).toHaveBeenCalledTimes(1);expect(jobs[0].skip).not.toHaveBeenCalled();
  await act(async()=>jobs[0].finish());expect(start).toHaveBeenCalledTimes(2);
  act(()=>jobs[1].commit());expect(document.documentElement.classList.contains("dark")).toBe(false);
  await act(async()=>jobs[1].finish());expect(start).toHaveBeenCalledTimes(2);expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
 });
 it("invalidates a pending palette commit and queued reversal on unmount",async()=>{
  const{jobs,start}=transitionFixture();
  const{rerender,unmount}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});
  rerender({theme:"dark"});rerender({theme:"light"});unmount();act(()=>jobs[0].commit());await act(async()=>jobs[0].finish());
  expect(jobs[0].skip).toHaveBeenCalledOnce();expect(start).toHaveBeenCalledTimes(1);expect(document.documentElement.classList.contains("dark")).toBe(false);expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
 });
 it("settles only color transitions, retaining running layout and interaction animations",()=>{
  const{jobs}=transitionFixture();
  class ColorTransition {finish=vi.fn();constructor(public transitionProperty:string){}}
  vi.stubGlobal("CSSTransition",ColorTransition);
  const color=new ColorTransition("background-color"),border=new ColorTransition("border-color"),layout=new ColorTransition("width"),move=new ColorTransition("transform"),fade=new ColorTransition("opacity");
  Object.defineProperty(document,"getAnimations",{configurable:true,value:()=>[color,border,layout,move,fade]});
  const{rerender}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});
  color.finish.mockClear();border.finish.mockClear();rerender({theme:"dark"});act(()=>jobs[0].commit());
  expect(color.finish).toHaveBeenCalledOnce();expect(border.finish).toHaveBeenCalledOnce();expect(layout.finish).not.toHaveBeenCalled();expect(move.finish).not.toHaveBeenCalled();expect(fade.finish).not.toHaveBeenCalled();
 });
 it("uses an atomic change when reduced motion is requested, including during a pending capture",()=>{
  const{jobs,start}=transitionFixture();
  const{rerender}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});rerender({theme:"dark"});
  vi.stubGlobal("matchMedia",(query:string)=>({matches:query.includes("prefers-reduced-motion")}));rerender({theme:"light"});act(()=>jobs[0].commit());
  expect(start).toHaveBeenCalledTimes(1);expect(jobs[0].skip).toHaveBeenCalledOnce();expect(document.documentElement.classList.contains("dark")).toBe(false);expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
 });
 it("falls back atomically when the API is absent or throws",()=>{
  vi.stubGlobal("matchMedia",()=>({matches:false}));
  const{rerender}=renderHook(({theme})=>useTheme(theme,true),{initialProps:{theme:"light" as "light"|"dark"}});rerender({theme:"dark"});expect(document.documentElement.classList.contains("dark")).toBe(true);
  Object.defineProperty(document,"startViewTransition",{configurable:true,value:()=>{throw Error("fixture unavailable compositor");}});
  rerender({theme:"light"});expect(document.documentElement.classList.contains("dark")).toBe(false);expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
 });
});
