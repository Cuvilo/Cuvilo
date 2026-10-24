import {beforeEach} from "vitest";

beforeEach(async () => {
  const {setLanguage}=await import("./i18n");
  if (typeof navigator !== "undefined") Object.defineProperty(navigator,"language",{configurable:true,value:"zh-CN"});
  setLanguage("zh-CN");
});
