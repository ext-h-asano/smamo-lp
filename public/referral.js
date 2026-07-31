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
  // /api/validate-ref のレスポンスを画面の状態へ翻訳する。
  // data が null/undefined（fetch 失敗）や { error: true }（サーバー側の疎通失敗）のときは
  // 「無効」と断定せず unknown にする。checkout 側の判定と食い違って
  // 有効なコードを弾いてしまうのを防ぐため。
  function interpretRefValidation(rawCode, data) {
    const code = (rawCode === null || rawCode === undefined ? "" : String(rawCode)).trim();
    if (!code) {
      return { code: "", empty: true, valid: false, waives: false, unknown: false };
    }
    const unknown = !data || Boolean(data.error);
    const valid = !unknown && Boolean(data.valid);
    return {
      code: (valid && data.code) || code.toUpperCase(),
      empty: false,
      valid,
      waives: valid && Boolean(data.waives_initial_fee),
      unknown,
    };
  }

  // 「無効と確定した」ときだけ Step 1 で止める。空欄・有効・判定不能は通す
  // （判定不能を止めると、疎通トラブルで申込が丸ごと不可能になるため）。
  function blocksSubmit(status) {
    if (!status) return false;
    return !status.empty && !status.valid && !status.unknown;
  }

  const api = { extractRefCode, interpretRefValidation, blocksSubmit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SmamoRef = api;
})(typeof window !== "undefined" ? window : globalThis);
