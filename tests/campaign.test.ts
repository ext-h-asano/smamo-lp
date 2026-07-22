import { describe, it, expect } from "vitest";
import camp from "../public/campaign.js";

describe("normalizeCampaignCode", () => {
  it("小文字化し trim する", () => {
    expect(camp.normalizeCampaignCode("FLYER")).toBe("flyer");
    expect(camp.normalizeCampaignCode("  Flyer  ")).toBe("flyer");
  });
  it("許可文字のみ通す", () => {
    expect(camp.normalizeCampaignCode("sns_x")).toBe("sns_x");
    expect(camp.normalizeCampaignCode("ads-google")).toBe("ads-google");
    expect(camp.normalizeCampaignCode("a1")).toBe("a1");
  });
  it("不正・空は空文字", () => {
    expect(camp.normalizeCampaignCode("")).toBe("");
    expect(camp.normalizeCampaignCode("   ")).toBe("");
    expect(camp.normalizeCampaignCode("bad code")).toBe("");
    expect(camp.normalizeCampaignCode("日本語")).toBe("");
    expect(camp.normalizeCampaignCode(null)).toBe("");
  });
});

describe("extractCampaignCode", () => {
  it("URL の ?c を取り正規化する", () => {
    expect(camp.extractCampaignCode("?c=FLYER", null)).toBe("flyer");
    expect(camp.extractCampaignCode("?c=%20sns_x%20", null)).toBe("sns_x");
  });
  it("URL に c が無ければ保存値へフォールバック", () => {
    expect(camp.extractCampaignCode("?email=x@y.z", "flyer")).toBe("flyer");
  });
  it("どちらも無ければ空文字", () => {
    expect(camp.extractCampaignCode("", null)).toBe("");
    expect(camp.extractCampaignCode("?c=", "")).toBe("");
  });
  it("URL が保存値より優先", () => {
    expect(camp.extractCampaignCode("?c=sns_x", "flyer")).toBe("sns_x");
  });
  it("不正な URL コードは保存値へフォールバックしない（URL キーはあるが無効）", () => {
    // normalize が "" を返すため fromUrl は空 → stored を使う
    expect(camp.extractCampaignCode("?c=bad code", "flyer")).toBe("flyer");
  });
});
