// @vitest-environment jsdom
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Answer,SessionEvent,Settings,Snapshot,Transcript} from './types';
import {useCopilot} from './hooks/use-copilot';
const api=vi.hoisted(()=>({invoke:vi.fn(),channel:null as {onmessage:(event:SessionEvent)=>void}|null}));
vi.mock('@tauri-apps/api/core',()=>({invoke:api.invoke,isTauri:()=>true,Channel:class{onmessage=()=>{};constructor(){api.channel=this;}}}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn(),save:vi.fn()}));
const settings:Settings={captureProtection:true,asrProvider:'',activeModel:'',providers:[],network:{mode:'direct',url:''},shortcuts:{answer:'Ctrl+Enter',cancel:'Ctrl+Shift+X',toggle:'Ctrl+Shift+H'},job:'fixture',silenceMs:700,fontSize:14};
const session={id:'session',title:'synthetic',createdAt:1,endedAt:null};
const answer:Answer={id:'answer',sessionId:'session',questionId:'question',revision:1,question:'synthetic question',text:'older text',status:'generating',mode:'short',createdAt:1,speechEndAt:1,triggerAt:1,requestAt:1,firstTokenMs:null,firstSentenceMs:null};
const transcript:Transcript={id:'transcript',sessionId:'session',source:'meeting',segmentId:'segment',text:'old partial',isFinal:false,at:1,speechEndAt:1};
const snapshot=():Snapshot=>({settings:structuredClone(settings),configured:[],notices:[],warnings:[],session,transcripts:[transcript],answers:[answer],materials:[],sessions:[session]});
const deferred=()=>{let resolve!:(snapshot:Snapshot)=>void;const promise=new Promise<Snapshot>(done=>{resolve=done;});return{promise,resolve};};
beforeEach(()=>{window.history.replaceState({},'','/');api.channel=null;api.invoke.mockReset().mockImplementation((name:string)=>Promise.resolve(name==='snapshot'?snapshot():name==='audio_sources'?[]:undefined));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('keeps answer and transcript events received during a delayed snapshot while accepting its materials',async()=>{
 const {result}=renderHook(()=>useCopilot());await waitFor(()=>expect(result.current.loaded).toBe(true));
 const pending=deferred();api.invoke.mockImplementation((name:string)=>name==='snapshot'?pending.promise:Promise.resolve(undefined));let refresh!:Promise<void>;
 act(()=>{refresh=result.current.refresh();});
 act(()=>{api.channel!.onmessage({type:'answer',sessionId:'session',answer:{...answer,text:'new OCR fallback',status:'complete'}});api.channel!.onmessage({type:'transcript',sessionId:'session',transcript:{...transcript,text:'complete final transcript',isFinal:true}});});
 const stale=snapshot();stale.materials=[{id:'material',title:'new material',kind:'knowledge',text:'synthetic content',enabled:true,updatedAt:1}];
 await act(async()=>{pending.resolve(stale);await refresh;});
 expect(result.current.data.answers[0].text).toBe('new OCR fallback');expect(result.current.data.answers[0].status).toBe('complete');expect(result.current.data.transcripts[0].text).toBe('complete final transcript');expect(result.current.data.materials[0].id).toBe('material');
});
it('discards an earlier snapshot after a newer refresh completes',async()=>{
 const {result}=renderHook(()=>useCopilot());await waitFor(()=>expect(result.current.loaded).toBe(true));
 const first=deferred(),second=deferred();let calls=0;api.invoke.mockImplementation((name:string)=>name==='snapshot'?(++calls===1?first.promise:second.promise):Promise.resolve(undefined));let older!:Promise<void>,newer!:Promise<void>;
 act(()=>{older=result.current.refresh();newer=result.current.refresh();});
 const latest=snapshot();latest.settings.job='newest settings';await act(async()=>{second.resolve(latest);await newer;});await act(async()=>{first.resolve(snapshot());await older;});expect(result.current.data.settings.job).toBe('newest settings');
});
it('keeps a final event received while a newly opened window is still waiting for its first snapshot',async()=>{
 const initial=deferred();api.invoke.mockImplementation((name:string)=>name==='snapshot'?initial.promise:Promise.resolve(name==='audio_sources'?[]:undefined));
 const {result}=renderHook(()=>useCopilot());await waitFor(()=>expect(api.channel).not.toBeNull());await waitFor(()=>expect(api.invoke).toHaveBeenCalledWith('snapshot'));
 act(()=>{api.channel!.onmessage({type:'answer',sessionId:'ended-session',answer:{...answer,id:'ended-answer',sessionId:'ended-session',text:'old session event'}});api.channel!.onmessage({type:'answer',sessionId:'session',answer:{...answer,text:'finished during window startup',status:'complete'}});});
 await act(async()=>initial.resolve(snapshot()));await waitFor(()=>expect(result.current.loaded).toBe(true));expect(result.current.data.answers[0].text).toBe('finished during window startup');expect(result.current.data.answers[0].status).toBe('complete');expect(result.current.data.answers).toHaveLength(1);
});
