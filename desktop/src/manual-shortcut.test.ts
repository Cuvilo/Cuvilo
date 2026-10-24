import{describe,it,expect}from"vitest";
import{manualShortcut,shortcutConflicts}from"./lib/shortcut-validation";
describe("manual shortcut compatibility",()=>{
 const old={answer:"Ctrl+Enter",cancel:"Ctrl+Shift+X",toggle:"Ctrl+Shift+H",screen:"Ctrl+Shift+S"};
 it("adds the default without replacing an existing binding or re-enabling a disabled one",()=>{expect(manualShortcut(old)).toBe("Ctrl+Shift+M");expect(manualShortcut({...old,answer:"Control+Shift+M"})).toBe("");expect(manualShortcut({...old,manual:""})).toBe("");expect(manualShortcut({...old,manual:"Ctrl+Alt+M"})).toBe("Ctrl+Alt+M");});
 it("reports explicitly duplicated manual bindings",()=>{expect(shortcutConflicts({...old,manual:"Ctrl+Enter"}).manual).toContain("立即回答");expect(shortcutConflicts({...old,answer:"Ctrl+Shift+M"})).toEqual({});});
});
