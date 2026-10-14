/**
 * App Store が署名した JWS（StoreKit 2 の signedTransaction、App Store Server Notifications V2 の
 * signedPayload / signedTransactionInfo / signedRenewalInfo）を検証する。
 *
 * Cloudflare Workers で動かすため Node の組み込みや x509 ライブラリは使わず、
 * 必要最小限の DER パーサと WebCrypto だけで実装している。
 *
 * 検証内容（Apple 公式 app-store-server-library と同じ方針）:
 *   1. ヘッダの alg が ES256、x5c がちょうど 3 枚（leaf / intermediate / root）
 *   2. x5c[2] が信頼する Apple Root CA - G3 とバイト一致
 *   3. intermediate が root で、leaf が intermediate で署名されている（各証明書の署名を WebCrypto で検証）
 *   4. issuer / subject の連鎖、intermediate が CA、各証明書の有効期限
 *   5. leaf に OID 1.2.840.113635.100.6.11.1、intermediate に OID 1.2.840.113635.100.6.2.1
 *   6. JWS 本体の ES256 署名を leaf の公開鍵で検証
 *
 * 有効期限の判定日時は payload の signedDate（無ければ現在時刻）。Apple のライブラリで
 * オンライン失効確認を無効にした場合と同じ。OCSP による失効確認はしていない。
 */

/** Apple Root CA - G3（https://www.apple.com/certificateauthority/AppleRootCA-G3.cer）。
 *  SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** leaf（App Store の署名証明書）に付く拡張の OID */
export const OID_APPLE_LEAF = "1.2.840.113635.100.6.11.1";
/** intermediate（Apple Worldwide Developer Relations CA）に付く拡張の OID */
export const OID_APPLE_INTERMEDIATE = "1.2.840.113635.100.6.2.1";

const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_P256 = "1.2.840.10045.3.1.7";
const OID_P384 = "1.3.132.0.34";
const SIG_ALGS: Record<string, "SHA-256" | "SHA-384"> = {
  "1.2.840.10045.4.3.2": "SHA-256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "SHA-384", // ecdsa-with-SHA384
};
const CURVES: Record<string, { name: "P-256" | "P-384"; size: number }> = {
  [OID_P256]: { name: "P-256", size: 32 },
  [OID_P384]: { name: "P-384", size: 48 },
};

export class AppleJwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleJwsError";
  }
}

export interface VerifyAppleJwsOptions {
  /** 信頼するルート証明書（DER）。省略時は Apple Root CA - G3。テストで差し替える用。 */
  trustedRoots?: Uint8Array[];
  /** 有効期限判定の日時を固定する（テスト用）。省略時は payload.signedDate → 現在時刻。 */
  now?: Date;
}

// ---------------------------------------------------------------------------
// base64 / PEM
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AppleJwsError("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 最小限の DER パーサ
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** ヘッダ込みの生バイト（署名対象の tbsCertificate などに使う） */
  raw: Uint8Array;
  /** 中身 */
  value: Uint8Array;
}

function readTlv(buf: Uint8Array, offset: number): { tlv: Tlv; next: number } {
  if (offset + 2 > buf.length) throw new AppleJwsError("asn1: truncated");
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new AppleJwsError("asn1: high tag numbers unsupported");
  let len = buf[offset + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new AppleJwsError("asn1: unsupported length");
    if (offset + 2 + n > buf.length) throw new AppleJwsError("asn1: truncated");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    hdr += n;
  }
  const end = offset + hdr + len;
  if (end > buf.length) throw new AppleJwsError("asn1: length overflow");
  return {
    tlv: { tag, raw: buf.subarray(offset, end), value: buf.subarray(offset + hdr, end) },
    next: end,
  };
}

function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < tlv.value.length) {
    const { tlv: c, next } = readTlv(tlv.value, off);
    out.push(c);
    off = next;
  }
  return out;
}

function expectTag(tlv: Tlv | undefined, tag: number, what: string): Tlv {
  if (!tlv || tlv.tag !== tag) throw new AppleJwsError(`asn1: expected ${what}`);
  return tlv;
}

function decodeOid(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new AppleJwsError("asn1: empty oid");
  const parts: number[] = [];
  const first = bytes[0];
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function decodeTime(tlv: Tlv): Date {
  const s = new TextDecoder().decode(tlv.value);
  let m: RegExpExecArray | null;
  if (tlv.tag === 0x17) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new AppleJwsError("asn1: bad UTCTime");
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, Number(m[2]) - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (tlv.tag === 0x18) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new AppleJwsError("asn1: bad GeneralizedTime");
    return new Date(Date.UTC(+m[1], Number(m[2]) - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  throw new AppleJwsError("asn1: expected time");
}

export interface ParsedCertificate {
  tbs: Uint8Array;
  signatureAlgorithm: string;
  /** DER の ECDSA-Sig-Value */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  spki: Uint8Array;
  curveOid: string | null;
  extensionOids: Set<string>;
  isCA: boolean;
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const { tlv: cert, next } = readTlv(der, 0);
  if (next !== der.length) throw new AppleJwsError("asn1: trailing bytes after certificate");
  const [tbsTlv, sigAlgTlv, sigTlv] = children(expectTag(cert, 0x30, "Certificate"));
  expectTag(tbsTlv, 0x30, "tbsCertificate");
  const sigAlgOid = decodeOid(expectTag(children(expectTag(sigAlgTlv, 0x30, "AlgorithmIdentifier"))[0], 0x06, "OID").value);
  expectTag(sigTlv, 0x03, "signature BIT STRING");
  if (sigTlv.value[0] !== 0) throw new AppleJwsError("asn1: unexpected unused bits");

  const tbs = children(tbsTlv);
  let i = 0;
  if (tbs[i]?.tag === 0xa0) i++; // version
  i++; // serialNumber
  const innerSigAlg = decodeOid(children(expectTag(tbs[i++], 0x30, "signature"))[0].value);
  if (innerSigAlg !== sigAlgOid) throw new AppleJwsError("cert: signature algorithm mismatch");
  const issuer = expectTag(tbs[i++], 0x30, "issuer");
  const validity = children(expectTag(tbs[i++], 0x30, "validity"));
  const subject = expectTag(tbs[i++], 0x30, "subject");
  const spki = expectTag(tbs[i++], 0x30, "subjectPublicKeyInfo");

  let curveOid: string | null = null;
  const spkiAlg = children(expectTag(children(spki)[0], 0x30, "spki algorithm"));
  if (decodeOid(spkiAlg[0].value) === OID_EC_PUBLIC_KEY && spkiAlg[1]?.tag === 0x06) {
    curveOid = decodeOid(spkiAlg[1].value);
  }

  const extensionOids = new Set<string>();
  let isCA = false;
  for (; i < tbs.length; i++) {
    if (tbs[i].tag !== 0xa3) continue;
    const exts = children(expectTag(children(tbs[i])[0], 0x30, "extensions"));
    for (const ext of exts) {
      const parts = children(expectTag(ext, 0x30, "extension"));
      const oid = decodeOid(expectTag(parts[0], 0x06, "extension oid").value);
      extensionOids.add(oid);
      if (oid === OID_BASIC_CONSTRAINTS) {
        const octet = expectTag(parts[parts.length - 1], 0x04, "extension value");
        const bc = children(readTlv(octet.value, 0).tlv);
        isCA = bc[0]?.tag === 0x01 && bc[0].value[0] !== 0;
      }
    }
  }

  return {
    tbs: tbsTlv.raw,
    signatureAlgorithm: sigAlgOid,
    signature: sigTlv.value.subarray(1),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: decodeTime(validity[0]),
    notAfter: decodeTime(validity[1]),
    spki: spki.raw,
    curveOid,
    extensionOids,
    isCA,
  };
}

/** DER の ECDSA-Sig-Value (SEQUENCE { r INTEGER, s INTEGER }) を WebCrypto 用の r||s に変換する */
function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const { tlv, next } = readTlv(der, 0);
  if (next !== der.length) throw new AppleJwsError("sig: trailing bytes");
  const [r, s] = children(expectTag(tlv, 0x30, "ECDSA-Sig-Value"));
  const out = new Uint8Array(size * 2);
  for (const [idx, int] of [r, s].entries()) {
    let v = expectTag(int, 0x02, "INTEGER").value;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new AppleJwsError("sig: integer too large");
    out.set(v, idx * size + (size - v.length));
  }
  return out;
}

async function importEcKey(cert: ParsedCertificate): Promise<{ key: CryptoKey; size: number }> {
  const curve = cert.curveOid ? CURVES[cert.curveOid] : undefined;
  if (!curve) throw new AppleJwsError("cert: unsupported public key");
  const key = await crypto.subtle.importKey(
    "spki",
    cert.spki,
    { name: "ECDSA", namedCurve: curve.name },
    false,
    ["verify"],
  );
  return { key, size: curve.size };
}

export async function verifyCertSignature(child: ParsedCertificate, issuer: ParsedCertificate): Promise<void> {
  const hash = SIG_ALGS[child.signatureAlgorithm];
  if (!hash) throw new AppleJwsError("cert: unsupported signature algorithm");
  if (!bytesEqual(child.issuer, issuer.subject)) throw new AppleJwsError("cert: issuer/subject mismatch");
  const { key, size } = await importEcKey(issuer);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash },
    key,
    derSignatureToRaw(child.signature, size),
    child.tbs,
  );
  if (!ok) throw new AppleJwsError("cert: signature invalid");
}

function checkValidity(cert: ParsedCertificate, at: Date, what: string): void {
  if (at < cert.notBefore || at > cert.notAfter) {
    throw new AppleJwsError(`cert: ${what} not valid at ${at.toISOString()}`);
  }
}

let defaultRoots: Uint8Array[] | null = null;

/**
 * Apple 署名 JWS を検証して payload を返す。不正なら AppleJwsError を投げる。
 */
export async function verifyAppleJws<T = Record<string, unknown>>(
  jws: string,
  opts: VerifyAppleJwsOptions = {},
): Promise<T> {
  if (typeof jws !== "string") throw new AppleJwsError("jws: not a string");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppleJwsError("jws: malformed");
  const [h, p, s] = parts;

  let header: { alg?: unknown; x5c?: unknown };
  let payload: T & { signedDate?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
  } catch (e) {
    if (e instanceof AppleJwsError) throw e;
    throw new AppleJwsError("jws: invalid json");
  }
  if (!header || header.alg !== "ES256") throw new AppleJwsError("jws: alg must be ES256");
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === "string")) {
    throw new AppleJwsError("jws: x5c must contain exactly 3 certificates");
  }

  let ders: Uint8Array[];
  try {
    ders = (x5c as string[]).map(base64ToBytes);
  } catch {
    throw new AppleJwsError("jws: x5c is not base64");
  }
  const roots = opts.trustedRoots ?? (defaultRoots ??= [pemToDer(APPLE_ROOT_CA_G3_PEM)]);
  if (!roots.some((r) => bytesEqual(r, ders[2]))) {
    throw new AppleJwsError("cert: root is not trusted");
  }

  const [leaf, intermediate, root] = ders.map(parseCertificate);

  const at =
    opts.now ??
    (typeof payload?.signedDate === "number" && Number.isFinite(payload.signedDate)
      ? new Date(payload.signedDate)
      : new Date());
  checkValidity(root, at, "root");
  checkValidity(intermediate, at, "intermediate");
  checkValidity(leaf, at, "leaf");

  if (!intermediate.isCA) throw new AppleJwsError("cert: intermediate is not a CA");
  if (!intermediate.extensionOids.has(OID_APPLE_INTERMEDIATE)) {
    throw new AppleJwsError("cert: intermediate lacks Apple OID");
  }
  if (!leaf.extensionOids.has(OID_APPLE_LEAF)) throw new AppleJwsError("cert: leaf lacks Apple OID");

  await verifyCertSignature(intermediate, root);
  await verifyCertSignature(leaf, intermediate);

  if (leaf.curveOid !== OID_P256) throw new AppleJwsError("jws: leaf key must be P-256 for ES256");
  const { key } = await importEcKey(leaf);
  const sig = base64UrlToBytes(s);
  if (sig.length !== 64) throw new AppleJwsError("jws: bad signature length");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new AppleJwsError("jws: signature invalid");

  return payload;
}
