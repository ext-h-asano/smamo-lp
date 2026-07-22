"use strict";
// キャンペーンコード抽出の純粋関数。ブラウザでは window.SmamoCampaign、Node（テスト）では module.exports。
(function (root) {
  // trim + 小文字。英数字と _ - のみ。不正・空は ""。
  function normalizeCampaignCode(raw) {
    if (raw === null || raw === undefined) return "";
    const s = String(raw).trim().toLowerCase();
    if (!s) return "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) return "";
    return s;
  }

  // URL の ?c を最優先、無ければ保存値。正規化後のコード。該当なしは ""。
  function extractCampaignCode(searchString, storedValue) {
    let fromUrl = "";
    try {
      fromUrl = normalizeCampaignCode(new URLSearchParams(searchString || "").get("c"));
    } catch (_e) {
      fromUrl = "";
    }
    if (fromUrl) return fromUrl;
    return normalizeCampaignCode(storedValue);
  }

  const api = { normalizeCampaignCode, extractCampaignCode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SmamoCampaign = api;
})(typeof window !== "undefined" ? window : globalThis);
