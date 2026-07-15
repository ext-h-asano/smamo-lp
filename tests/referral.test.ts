import { describe, it, expect } from "vitest";
import reflib from "../public/referral.js";

describe("extractRefCode", () => {
  it("URL の ?ref を取り、trim + 大文字化する", () => {
    expect(reflib.extractRefCode("?ref=pabio01", null)).toBe("PABIO01");
    expect(reflib.extractRefCode("?ref=%20abc%20", null)).toBe("ABC");
  });
  it("URL に ref が無ければ保存値へフォールバック", () => {
    expect(reflib.extractRefCode("?email=x@y.z", "child07")).toBe("CHILD07");
  });
  it("どちらも無ければ空文字", () => {
    expect(reflib.extractRefCode("", null)).toBe("");
    expect(reflib.extractRefCode("?ref=", "")).toBe("");
  });
  it("URL が保存値より優先", () => {
    expect(reflib.extractRefCode("?ref=urlcode", "storedcode")).toBe("URLCODE");
  });
});
