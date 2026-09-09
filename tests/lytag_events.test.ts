import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../public/lytag-events.js", import.meta.url)),
  "utf8",
);
const TAG_ID = "fd83709f-6cae-4d2b-b17c-006dd993216c";

type Event = { type: string; eventType: string; tagId: string };

/**
 * lytag-events.js を実ブラウザに似せた偽の window/document 上で実行する。
 * 返り値の click() で LINE ボタンのクリックを再現できる。
 */
function load(opts: {
  search?: string;
  hostname?: string;
  hasGlobalSnippet?: boolean;
  storage?: Map<string, string> | null;
} = {}) {
  const sent: Event[] = [];
  const store = opts.storage === undefined ? new Map<string, string>() : opts.storage;
  let clickHandler: ((e: unknown) => void) | null = null;

  const win: Record<string, unknown> = {
    location: { search: opts.search ?? "", hostname: opts.hostname ?? "smamo.jp" },
  };
  if (opts.hasGlobalSnippet !== false) {
    win.lytag = (payload: Event) => sent.push(payload);
  }

  const sandbox = {
    window: win,
    document: {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === "click") clickHandler = fn;
      },
    },
    sessionStorage: store
      ? {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => void store.set(k, v),
        }
      : {
          // プライベートモードの Safari は setItem で例外を投げる。
          getItem: () => { throw new Error("denied"); },
          setItem: () => { throw new Error("denied"); },
        },
    URLSearchParams,
  };

  runInContext(SRC, createContext(sandbox));

  return {
    sent,
    /** href を持つ <a> の中の要素をクリックしたことにする */
    click(href: string | null) {
      const link = href === null ? null : { href };
      clickHandler?.({ target: { closest: (sel: string) => (sel.includes("line.me") && href && href.includes("line.me") ? link : null) } });
    },
    /** closest を持たないターゲット (text node 等) のクリック */
    clickRawTarget(target: unknown) {
      clickHandler?.({ target });
    },
  };
}

describe("sign_up (無料体験の申込完了)", () => {
  it("Stripe から成功で戻ってきたら発火する", () => {
    const { sent } = load({ search: "?setup_intent=seti_123&redirect_status=succeeded" });
    expect(sent).toEqual([{ type: "event", eventType: "sign_up", tagId: TAG_ID }]);
  });

  it("/thankyou を直接開いただけでは発火しない", () => {
    expect(load({ search: "" }).sent).toEqual([]);
  });

  it("失敗して戻ってきたときは発火しない", () => {
    const { sent } = load({ search: "?setup_intent=seti_123&redirect_status=failed" });
    expect(sent).toEqual([]);
  });

  it("同じ申込のリロードでは二重に発火しない", () => {
    const store = new Map<string, string>();
    const search = "?setup_intent=seti_123&redirect_status=succeeded";
    expect(load({ search, storage: store }).sent).toHaveLength(1);
    expect(load({ search, storage: store }).sent).toHaveLength(0);
  });

  it("別の申込なら改めて発火する", () => {
    const store = new Map<string, string>();
    load({ search: "?setup_intent=seti_A&redirect_status=succeeded", storage: store });
    const second = load({ search: "?setup_intent=seti_B&redirect_status=succeeded", storage: store });
    expect(second.sent).toHaveLength(1);
  });

  it("sessionStorage が使えなくても取りこぼさない", () => {
    const { sent } = load({ search: "?setup_intent=seti_123&redirect_status=succeeded", storage: null });
    expect(sent).toHaveLength(1);
  });
});

describe("generate_lead (LINE 問い合わせ)", () => {
  it("LINE ボタンのクリックで発火する", () => {
    const t = load();
    t.click("https://line.me/R/ti/p/@808icbev");
    expect(t.sent).toEqual([{ type: "event", eventType: "generate_lead", tagId: TAG_ID }]);
  });

  it("LINE 以外のリンクでは発火しない", () => {
    const t = load();
    t.click("https://smamo.jp/contact");
    expect(t.sent).toEqual([]);
  });

  it("リンク外のクリックでは発火しない", () => {
    const t = load();
    t.click(null);
    expect(t.sent).toEqual([]);
  });

  it("closest を持たないターゲットでも落ちない", () => {
    const t = load();
    expect(() => t.clickRawTarget({})).not.toThrow();
    expect(() => t.clickRawTarget(null)).not.toThrow();
    expect(t.sent).toEqual([]);
  });

  it("押すたびに発火する (複数箇所のボタン)", () => {
    const t = load();
    t.click("https://line.me/R/ti/p/@808icbev");
    t.click("https://line.me/R/ti/p/@808icbev");
    expect(t.sent).toHaveLength(2);
  });
});

describe("本番ドメイン以外", () => {
  const SIGNUP = "?setup_intent=seti_1&redirect_status=succeeded";

  it("dev.smamo.jp のテスト申込は計上しない", () => {
    const t = load({ hostname: "dev.smamo.jp", search: SIGNUP });
    t.click("https://line.me/R/ti/p/@808icbev");
    expect(t.sent).toEqual([]);
  });

  it("Pages のプレビュー URL でも計上しない", () => {
    const t = load({ hostname: "53b47312.smamo-lp.pages.dev", search: SIGNUP });
    t.click("https://line.me/R/ti/p/@808icbev");
    expect(t.sent).toEqual([]);
  });

  it("www 付きの本番ドメインは計上する", () => {
    expect(load({ hostname: "www.smamo.jp", search: SIGNUP }).sent).toHaveLength(1);
  });
});

describe("グローバルスニペットが無い環境", () => {
  it("lytag 未定義でも例外を出さない", () => {
    const t = load({ hasGlobalSnippet: false, search: "?setup_intent=seti_1&redirect_status=succeeded" });
    expect(() => t.click("https://line.me/R/ti/p/@808icbev")).not.toThrow();
    expect(t.sent).toEqual([]);
  });
});
