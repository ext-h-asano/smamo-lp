/**
 * テスト用に Apple と同じ形の証明書チェーン（root P-384 / intermediate P-384 / leaf P-256）を
 * WebCrypto で生成し、App Store 形式の JWS に署名する。本物の Apple 鍵は一切使わない。
 */
import { OID_APPLE_INTERMEDIATE, OID_APPLE_LEAF } from "../../functions/_lib/apple_jws";

// ---------------- DER エンコーダ ----------------
function len(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}
function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(new Uint8Array([tag, ...len(body.length)]), body);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
function oid(s: string): Uint8Array {
  const p = s.split(".").map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const b: number[] = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) {
      b.unshift((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    out.push(...b);
  }
  return tlv(0x06, new Uint8Array(out));
}
function int(bytes: Uint8Array): Uint8Array {
  let v = bytes;
  while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1);
  if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
  return tlv(0x02, v);
}
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
function genTime(d: Date): Uint8Array {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return tlv(0x18, new TextEncoder().encode(s));
}
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------- 証明書 ----------------
type Curve = "P-256" | "P-384";
interface Issued {
  der: Uint8Array;
  keys: CryptoKeyPair;
  curve: Curve;
  cn: string;
}

async function genKey(curve: Curve): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

let serial = 1;
async function issueCert(opts: {
  cn: string;
  curve: Curve;
  issuer?: Issued; // 省略 = 自己署名
  ca: boolean;
  extraOids?: string[];
  notBefore?: Date;
  notAfter?: Date;
}): Promise<Issued> {
  const keys = await genKey(opts.curve);
  const signer = opts.issuer ?? { keys, curve: opts.curve, cn: opts.cn };
  const hash = signer.curve === "P-384" ? "SHA-384" : "SHA-256";
  const sigAlg = seq(oid(hash === "SHA-384" ? "1.2.840.10045.4.3.3" : "1.2.840.10045.4.3.2"));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));

  const exts: Uint8Array[] = [];
  if (opts.ca) {
    exts.push(seq(oid("2.5.29.19"), tlv(0x01, new Uint8Array([0xff])), tlv(0x04, seq(tlv(0x01, new Uint8Array([0xff]))))));
  }
  for (const o of opts.extraOids ?? []) exts.push(seq(oid(o), tlv(0x04, new Uint8Array([0x05, 0x00]))));

  const tbs = seq(
    tlv(0xa0, int(new Uint8Array([2]))),
    int(new Uint8Array([0, serial++])),
    sigAlg,
    name(signer.cn),
    seq(
      genTime(opts.notBefore ?? new Date("2020-01-01T00:00:00Z")),
      genTime(opts.notAfter ?? new Date("2040-01-01T00:00:00Z")),
    ),
    name(opts.cn),
    spki,
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, signer.keys.privateKey, tbs));
  const size = raw.length / 2;
  const sigDer = seq(int(raw.subarray(0, size)), int(raw.subarray(size)));
  const der = seq(tbs, sigAlg, tlv(0x03, concat(new Uint8Array([0]), sigDer)));
  return { der, keys, curve: opts.curve, cn: opts.cn };
}

export interface FakeChain {
  root: Issued;
  intermediate: Issued;
  leaf: Issued;
}

export async function makeFakeChain(
  o: {
    leafOids?: string[];
    intermediateOids?: string[];
    intermediateCa?: boolean;
    leafNotAfter?: Date;
    signIntermediateWith?: Issued;
  } = {},
): Promise<FakeChain> {
  const root = await issueCert({ cn: "Fake Apple Root CA - G3", curve: "P-384", ca: true });
  const intermediate = await issueCert({
    cn: "Fake Apple WWDR CA - G6",
    curve: "P-384",
    issuer: o.signIntermediateWith ?? root,
    ca: o.intermediateCa ?? true,
    extraOids: o.intermediateOids ?? [OID_APPLE_INTERMEDIATE],
  });
  const leaf = await issueCert({
    cn: "Fake Prod ECC Mac App Store and iTunes Store Receipt Signing",
    curve: "P-256",
    issuer: intermediate,
    ca: false,
    extraOids: o.leafOids ?? [OID_APPLE_LEAF],
    notAfter: o.leafNotAfter,
  });
  return { root, intermediate, leaf };
}

/** チェーンの leaf 鍵で ES256 の JWS を作る */
export async function signJws(chain: FakeChain, payload: unknown, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        alg: "ES256",
        x5c: [chain.leaf.der, chain.intermediate.der, chain.root.der].map(b64),
        ...header,
      }),
    ),
  );
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chain.leaf.keys.privateKey, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

let shared: Promise<FakeChain> | null = null;
/** テストファイル間で共有するチェーン（生成が少し重いので 1 回だけ作る） */
export function sharedFakeChain(): Promise<FakeChain> {
  return (shared ??= makeFakeChain());
}
