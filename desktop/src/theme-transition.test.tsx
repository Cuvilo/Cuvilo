// @vitest-environment jsdom
import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useTheme} from "./hooks/use-theme";
import type {Settings} from "./types";
const api=vi.hoisted(()=>({invoke:vi.fn().mockResolvedValue(undefined)}));vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();document.documentElement.classList.remove("dark");document.documentElement.removeAttribute("data-theme-transition");});
beforeEach(()=>{api.invoke.mockReset().mockResolvedValue(undefined);localStorage.clear();Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));});
it("prepares one shared native clock and coalesces a reverse click until the current fade finishes",async()=>{
 class Effect{pseudoElement="::view-transition-new(root)";}
 vi.stubGlobal("KeyframeEffect",Effect);const animation={effect:new Effect(),startTime:null as number|null,play:vi.fn()};Object.defineProperty(document,"getAnimations",{configurable:true,value:()=>[animation]});api.invoke.mockImplementation((name:string)=>Promise.resolve(name==="prepare_theme_transition"?performance.timeOrigin+123:undefined));
 const transitions:{commit:()=>void;ready:ReturnType<typeof deferred>;finished:ReturnType<typeof deferred>}[]=[];
 const start=vi.fn((commit:()=>void)=>{const ready=deferred(),finished=deferred();transitions.push({commit,ready,finished});return{ready:ready.promise,finished:finished.promise,skipTransition:vi.fn()};});Object.defineProperty(document,"startViewTransition",{configurable:true,value:start});
 const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"dark"});expect(api.invoke).not.toHaveBeenCalled();
 act(()=>transitions[0].commit());rerender({theme:"light"});await act(async()=>transitions[0].ready.resolve());expect(api.invoke).toHaveBeenLastCalledWith("prepare_theme_transition",{theme:"dark",resolvedDark:true});expect(animation.startTime).toBe(123);expect(animation.play).toHaveBeenCalled();expect(start).toHaveBeenCalledTimes(1);
 await act(async()=>transitions[0].finished.resolve());expect(start).toHaveBeenCalledTimes(2);act(()=>transitions[1].commit());await act(async()=>transitions[1].ready.resolve());expect(api.invoke).toHaveBeenLastCalledWith("prepare_theme_transition",{theme:"light",resolvedDark:false});await act(async()=>transitions[1].finished.resolve());expect(document.documentElement.hasAttribute("data-theme-transition")).toBe(false);
});
it("switches both surfaces atomically when motion is reduced",()=>{
 vi.stubGlobal("matchMedia",()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"dark"});expect(document.documentElement.classList.contains("dark")).toBe(true);expect(api.invoke).toHaveBeenLastCalledWith("preview_theme",{theme:"dark",resolvedDark:true,startedAtMs:null});
});
it("does not submit a late native transition after the renderer is disposed",async()=>{
 const ready=deferred(),finished=deferred();Object.defineProperty(document,"startViewTransition",{configurable:true,value:()=>({ready:ready.promise,finished:finished.promise,skipTransition:vi.fn()})});
 const {rerender,unmount}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"dark"});unmount();await act(async()=>{ready.resolve();finished.resolve();});expect(api.invoke).not.toHaveBeenCalled();
});
function transitionFixture(){
 const transitions:{commit:()=>void;ready:ReturnType<typeof deferred>;finished:ReturnType<typeof deferred>}[]=[];
 Object.defineProperty(document,"getAnimations",{configurable:true,value:()=>[]});
 const start=vi.fn((commit:()=>void)=>{const ready=deferred(),finished=deferred();transitions.push({commit,ready,finished});return{ready:ready.promise,finished:finished.promise,skipTransition:vi.fn()};});
 Object.defineProperty(document,"startViewTransition",{configurable:true,value:start});return{transitions,start};
}
it("resolves the actual OS dark theme before capturing light-to-system instead of using forced-light media",async()=>{
 const {transitions,start}=transitionFixture();api.invoke.mockImplementation((name:string)=>Promise.resolve(name==="system_theme_dark"?true:name==="prepare_theme_transition"?Date.now()+64:undefined));
 const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});
 rerender({theme:"system"});expect(start).not.toHaveBeenCalled();await act(async()=>{});expect(api.invoke).toHaveBeenCalledWith("system_theme_dark");expect(start).toHaveBeenCalledTimes(1);act(()=>transitions[0].commit());expect(document.documentElement.classList.contains("dark")).toBe(true);
 await act(async()=>transitions[0].ready.resolve());expect(api.invoke).toHaveBeenLastCalledWith("prepare_theme_transition",{theme:"system",resolvedDark:true});await act(async()=>transitions[0].finished.resolve());expect(start).toHaveBeenCalledTimes(1);
});
it("releases the native override when choosing system with the same resolved palette",async()=>{
 const {start}=transitionFixture();api.invoke.mockImplementation((name:string)=>Promise.resolve(name==="system_theme_dark"?false:undefined));
 const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"system"});await act(async()=>{});
 expect(start).not.toHaveBeenCalled();expect(api.invoke).toHaveBeenLastCalledWith("preview_theme",{theme:"system",resolvedDark:false,startedAtMs:null});
});
it("ignores a delayed OS resolution after the user has already selected an explicit theme",async()=>{
 let resolve!:(dark:boolean)=>void;const pending=new Promise<boolean>(done=>{resolve=done;});api.invoke.mockImplementation((name:string)=>name==="system_theme_dark"?pending:Promise.resolve(undefined));Object.defineProperty(document,"startViewTransition",{configurable:true,value:undefined});
 const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"system"});rerender({theme:"dark"});await act(async()=>resolve(false));expect(document.documentElement.classList.contains("dark")).toBe(true);expect(api.invoke).toHaveBeenLastCalledWith("preview_theme",{theme:"dark",resolvedDark:true,startedAtMs:null});
});
it("resolves the same system palette in the native answer window without dispatching caption changes",async()=>{
 Object.defineProperty(document,"startViewTransition",{configurable:true,value:undefined});api.invoke.mockImplementation((name:string)=>Promise.resolve(name==="system_theme_dark"?true:name==="prepare_theme_transition"?Date.now()+64:undefined));renderHook(()=>useTheme("system",true,false,true));await act(async()=>{});expect(document.documentElement.classList.contains("dark")).toBe(true);expect(api.invoke.mock.calls.map(call=>call[0])).toEqual(["system_theme_dark"]);
});

it("keeps the old palette animation paused until native preparation replies with a start clock",async()=>{
 const {transitions}=transitionFixture();let resolve!:(start:number)=>void;const pending=new Promise<number>(done=>{resolve=done;});api.invoke.mockImplementation((name:string)=>name==="prepare_theme_transition"?pending:Promise.resolve(undefined));
 const {rerender}=renderHook(({theme}:{theme:Settings["theme"]})=>useTheme(theme,true,true),{initialProps:{theme:"light" as Settings["theme"]}});rerender({theme:"dark"});act(()=>transitions[0].commit());await act(async()=>transitions[0].ready.resolve());expect(document.documentElement.dataset.themeTransition).toBe("preparing");await act(async()=>resolve(Date.now()+64));expect(document.documentElement.dataset.themeTransition).toBe("true");await act(async()=>transitions[0].finished.resolve());
});
