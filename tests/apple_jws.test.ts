import { describe, it, expect } from "vitest";
import {
  APPLE_ROOT_CA_G3_PEM,
  AppleJwsError,
  OID_APPLE_INTERMEDIATE,
  parseCertificate,
  pemToDer,
  verifyAppleJws,
  verifyCertSignature,
} from "../functions/_lib/apple_jws";
import { b64url, makeFakeChain, sharedFakeChain, signJws } from "./helpers/fake_apple_chain";

const payload = { bundleId: "cx.ext.smamo", productId: "cx.ext.smamo.monthly", signedDate: Date.parse("2026-10-14T00:00:00Z") };

describe("Apple Root CA - G3 の埋め込み", () => {
  it("本物の Apple ルート証明書として解析できる", () => {
    const root = parseCertificate(pemToDer(APPLE_ROOT_CA_G3_PEM));
    expect(root.isCA).toBe(true);
    expect(root.curveOid).toBe("1.3.132.0.34"); // P-384
    expect(root.notBefore.toISOString()).toBe("2014-04-30T18:19:06.000Z");
    expect(root.notAfter.toISOString()).toBe("2039-04-30T18:19:06.000Z");
    expect(new TextDecoder().decode(root.subject)).toContain("Apple Root CA - G3");
  });
});

/** 本物の Apple Worldwide Developer Relations CA - G6（App Store の JWS の intermediate）。公開証明書。 */
const APPLE_WWDR_G6_PEM = `-----BEGIN CERTIFICATE-----
MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMw
ZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBD
ZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkG
A1UEBhMCVVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYD
VQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZp
Y2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIElu
Yy4xCzAJBgNVBAYTAlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWm
ZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT8JMEb7FDi4bBmPhCnZ3/sq6PF/cGcKXW
sL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIG
A1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rL
JKswRgYIKwYBBQUHAQEEOjA4MDYGCCsGAQUFBzABhipodHRwOi8vb2NzcC5hcHBs
ZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0
cDovL2NybC5hcHBsZS5jb20vYXBwbGVyb290Y2FnMy5jcmwwHQYDVR0OBBYEFD8v
lCNR01DJmig97bB85c+lkGKZMA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIB
BAIFADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXuf
QB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxarZXvNrkxU3TkUMI33yzvFVVR
T4wxWJC994OsdcZ4+RGNsYDyR5gmdr0nDGg=
-----END CERTIFICATE-----`;

describe("本物の Apple 証明書での検証", () => {
  it("本物の WWDR G6 は本物の Root G3 で署名されていると判定できる", async () => {
    const root = parseCertificate(pemToDer(APPLE_ROOT_CA_G3_PEM));
    const g6 = parseCertificate(pemToDer(APPLE_WWDR_G6_PEM));
    expect(g6.isCA).toBe(true);
    expect(g6.extensionOids.has(OID_APPLE_INTERMEDIATE)).toBe(true);
    await expect(verifyCertSignature(g6, root)).resolves.toBeUndefined();
  });

  it("1 バイト改ざんした G6 は拒否する", async () => {
    const root = parseCertificate(pemToDer(APPLE_ROOT_CA_G3_PEM));
    const der = pemToDer(APPLE_WWDR_G6_PEM);
    der[200] ^= 0x01; // tbsCertificate の中
    await expect(verifyCertSignature(parseCertificate(der), root)).rejects.toThrow(AppleJwsError);
  });
});

describe("verifyAppleJws", () => {
  it("正しいチェーンと署名なら payload を返す", async () => {
    const chain = await sharedFakeChain();
    const jws = await signJws(chain, payload);
    const got = await verifyAppleJws(jws, { trustedRoots: [chain.root.der] });
    expect(got).toEqual(payload);
  });

  it("payload の改ざんを拒否する", async () => {
    const chain = await sharedFakeChain();
    const [h, , s] = (await signJws(chain, payload)).split(".");
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, productId: "x" })));
    await expect(verifyAppleJws(`${h}.${forged}.${s}`, { trustedRoots: [chain.root.der] })).rejects.toThrow(
      /signature invalid/,
    );
  });

  it("署名の改ざんを拒否する", async () => {
    const chain = await sharedFakeChain();
    const jws = await signJws(chain, payload);
    const last = jws.at(-2) === "A" ? "B" : "A";
    const tampered = jws.slice(0, -2) + last + jws.slice(-1);
    await expect(verifyAppleJws(tampered, { trustedRoots: [chain.root.der] })).rejects.toThrow(AppleJwsError);
  });

  it("Apple 以外のルートは拒否する（既定の信頼ルート = 本物の Apple Root CA - G3）", async () => {
    const chain = await sharedFakeChain();
    const jws = await signJws(chain, payload);
    await expect(verifyAppleJws(jws)).rejects.toThrow(/root is not trusted/);
  });

  it("x5c の root を信頼ルートに差し替えても、intermediate がそのルートで署名されていなければ拒否する", async () => {
    const chain = await sharedFakeChain();
    const other = await makeFakeChain();
    const jws = await signJws({ ...chain, root: other.root }, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [other.root.der] })).rejects.toThrow(
      /issuer\/subject mismatch|signature invalid/,
    );
  });

  it("別の鍵で署名された intermediate（同名の偽ルート）を拒否する", async () => {
    const trusted = await makeFakeChain();
    const attacker = await makeFakeChain();
    // 攻撃者は信頼ルートと同じ名前の自前ルートで intermediate を署名し、x5c には本物のルートを載せる
    const forged = await makeFakeChain({ signIntermediateWith: { ...attacker.root, cn: trusted.root.cn } });
    const jws = await signJws({ ...forged, root: trusted.root }, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [trusted.root.der] })).rejects.toThrow(/signature invalid/);
  });

  it("leaf に Apple の OID が無ければ拒否する", async () => {
    const chain = await makeFakeChain({ leafOids: [] });
    const jws = await signJws(chain, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(/leaf lacks Apple OID/);
  });

  it("intermediate に Apple の OID が無ければ拒否する", async () => {
    const chain = await makeFakeChain({ intermediateOids: [] });
    const jws = await signJws(chain, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(
      /intermediate lacks Apple OID/,
    );
  });

  it("intermediate が CA でなければ拒否する", async () => {
    const chain = await makeFakeChain({ intermediateCa: false, intermediateOids: [OID_APPLE_INTERMEDIATE] });
    const jws = await signJws(chain, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(/not a CA/);
  });

  it("期限切れの leaf を拒否する（判定日時は signedDate）", async () => {
    const chain = await makeFakeChain({ leafNotAfter: new Date("2026-01-01T00:00:00Z") });
    const jws = await signJws(chain, payload);
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(/leaf not valid/);
    // 署名時点で有効なら通る
    const old = await signJws(chain, { ...payload, signedDate: Date.parse("2025-06-01T00:00:00Z") });
    await expect(verifyAppleJws(old, { trustedRoots: [chain.root.der] })).resolves.toBeTruthy();
  });

  it("alg が ES256 以外なら拒否する", async () => {
    const chain = await sharedFakeChain();
    const jws = await signJws(chain, payload, { alg: "none" });
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(/ES256/);
  });

  it("x5c が 3 枚でなければ拒否する", async () => {
    const chain = await sharedFakeChain();
    const jws = await signJws(chain, payload, { x5c: [] });
    await expect(verifyAppleJws(jws, { trustedRoots: [chain.root.der] })).rejects.toThrow(/exactly 3/);
  });

  it("形式不正を AppleJwsError にする", async () => {
    await expect(verifyAppleJws("abc")).rejects.toThrow(AppleJwsError);
    await expect(verifyAppleJws("a.b.c")).rejects.toThrow(AppleJwsError);
    await expect(verifyAppleJws(undefined as never)).rejects.toThrow(AppleJwsError);
  });
});
