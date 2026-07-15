"use strict";
// 紹介コード抽出の純粋関数。ブラウザでは window.SmamoRef、Node（テスト）では module.exports。
(function (root) {
  // URL の ?ref を最優先、無ければ保存値。正規化は trim + 大文字化。該当なしは "".
  function extractRefCode(searchString, storedValue) {
    const norm = (v) => (v === null || v === undefined ? "" : String(v).trim().toUpperCase());
    let fromUrl = "";
    try {
      fromUrl = norm(new URLSearchParams(searchString || "").get("ref"));
    } catch (_e) {
      fromUrl = "";
    }
    if (fromUrl) return fromUrl;
    return norm(storedValue);
  }
  const api = { extractRefCode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SmamoRef = api;
})(typeof window !== "undefined" ? window : globalThis);
