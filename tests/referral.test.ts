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

describe("interpretRefValidation", () => {
  it("空欄は empty（止めない）", () => {
    const s = reflib.interpretRefValidation("", { valid: false });
    expect(s).toMatchObject({ empty: true, valid: false, unknown: false });
    expect(reflib.blocksSubmit(s)).toBe(false);
  });
  it("空白だけの入力も empty 扱い", () => {
    expect(reflib.interpretRefValidation("   ", null).empty).toBe(true);
  });
  it("有効なコードは valid + サーバー正規化コードを採用", () => {
    const s = reflib.interpretRefValidation(" pabio01 ", {
      valid: true,
      code: "PABIO01",
      waives_initial_fee: true,
    });
    expect(s).toMatchObject({ valid: true, code: "PABIO01", waives: true, unknown: false });
    expect(reflib.blocksSubmit(s)).toBe(false);
  });
  it("免除対象でないコードは valid でも waives=false", () => {
    const s = reflib.interpretRefValidation("CHILD07", { valid: true, code: "CHILD07" });
    expect(s.valid).toBe(true);
    expect(s.waives).toBe(false);
  });
  it("valid:false は無効と確定 → Step 1 で止める", () => {
    const s = reflib.interpretRefValidation("NOPE", { valid: false });
    expect(s).toMatchObject({ valid: false, unknown: false });
    expect(reflib.blocksSubmit(s)).toBe(true);
  });
  it("サーバー側の疎通失敗 (error:true) は unknown → 止めない", () => {
    const s = reflib.interpretRefValidation("PABIO01", { valid: false, error: true });
    expect(s.unknown).toBe(true);
    expect(reflib.blocksSubmit(s)).toBe(false);
  });
  it("fetch 失敗 (data なし) も unknown → 止めない", () => {
    const s = reflib.interpretRefValidation("PABIO01", null);
    expect(s.unknown).toBe(true);
    expect(s.code).toBe("PABIO01");
    expect(reflib.blocksSubmit(s)).toBe(false);
  });
});
