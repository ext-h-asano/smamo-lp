import { describe, it, expect } from "vitest";
import { normalizeCampaignCode } from "../functions/_lib/campaign";

describe("functions/_lib/campaign normalizeCampaignCode", () => {
  it("ブラウザ側と同規則", () => {
    expect(normalizeCampaignCode("FLYER")).toBe("flyer");
    expect(normalizeCampaignCode("sns_x")).toBe("sns_x");
    expect(normalizeCampaignCode("bad code")).toBe("");
  });
});
