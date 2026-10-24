// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {AnswerText} from "./components/answer-panel";
import {previewAnswers} from "./lib/preview";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("copies exactly one fenced block with indentation, symbols and no surrounding prose",async()=>{
 const code="def compare(a, b):\n    return a < b and b != 0\n",copy=vi.fn().mockResolvedValue(true);
 render(<AnswerText answer={{...previewAnswers[0],text:"说明\n\n```python\n"+code+"```\n\n结论"}} fontSize={14} onCopy={copy}/>);
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"复制代码"}));});expect(copy).toHaveBeenCalledWith(code);expect(screen.getByRole("button",{name:"代码已复制"})).toBeTruthy();
});
it("keeps a streaming code viewport mounted, copies the latest text and supports unlabeled fences",async()=>{
 const copy=vi.fn().mockResolvedValue(true),answer={...previewAnswers[0],text:"```\nfirst line\n```",status:"generating"};const view=render(<AnswerText answer={answer} fontSize={14} onCopy={copy}/>);
 const pre=view.container.querySelector("pre")!;pre.scrollLeft=75;
 view.rerender(<AnswerText answer={{...answer,text:"```\nfirst line\n    next line\n```"}} fontSize={14} onCopy={value=>copy(value)}/>);
 expect(view.container.querySelector("pre")).toBe(pre);expect(pre.scrollLeft).toBe(75);
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"复制代码"}));});expect(copy).toHaveBeenLastCalledWith("first line\n    next line\n");
});
it("keeps inline code and collapsed excerpts free of copy buttons, and handles copy failure locally",async()=>{
 const view=render(<AnswerText answer={{...previewAnswers[0],text:"Use `value` and \n\n```js\nconst a = 1;\n```"}} fontSize={14} codeCopy={false}/>);expect(screen.queryByRole("button")).toBeNull();
 view.rerender(<AnswerText answer={{...previewAnswers[0],text:"```js\nconst a = 1;\n```"}} fontSize={14} onCopy={async()=>false}/>);await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"复制代码"}));});expect(screen.getByRole("alert").textContent).toContain("复制失败");expect(view.container.querySelector("code")?.textContent).toBe("const a = 1;\n");
});
