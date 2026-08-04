import { describe, expect, it } from "vite-plus/test";
import { isAllowedMcpOrigin } from "../src/mcp-origin";

const PROD = "https://kichijitsu.love-rox.cc/mcp";

describe("isAllowedMcpOrigin", () => {
  describe("Origin が無い場合 (非ブラウザクライアント)", () => {
    // 仕様の条件は "present and invalid"。Claude Desktop / Claude Code 等は
    // Origin を送らないので、ここを拒否すると既存クライアントが全滅する。
    it("undefined を許可する", () => {
      expect(isAllowedMcpOrigin(undefined, PROD)).toBe(true);
    });

    it("null (ヘッダ未設定) を許可する", () => {
      expect(isAllowedMcpOrigin(null, PROD)).toBe(true);
    });

    it("空文字を許可する", () => {
      expect(isAllowedMcpOrigin("", PROD)).toBe(true);
    });
  });

  describe("同一オリジン", () => {
    it("スキーム・ホスト・ポートが一致すれば許可する", () => {
      expect(isAllowedMcpOrigin("https://kichijitsu.love-rox.cc", PROD)).toBe(true);
    });

    it("パス付きで送られてきても origin 部分だけで判定する", () => {
      expect(isAllowedMcpOrigin("https://kichijitsu.love-rox.cc/app", PROD)).toBe(true);
    });

    it("スキームが違えば拒否する (http vs https)", () => {
      expect(isAllowedMcpOrigin("http://kichijitsu.love-rox.cc", PROD)).toBe(false);
    });
  });

  describe("別オリジン (DNS リバインディング / 悪意あるサイト)", () => {
    it("無関係なオリジンを拒否する", () => {
      expect(isAllowedMcpOrigin("https://evil.example", PROD)).toBe(false);
    });

    // サブドメインは別オリジン。ワイルドカード許可はしない。
    it("サブドメインを拒否する", () => {
      expect(isAllowedMcpOrigin("https://evil.kichijitsu.love-rox.cc", PROD)).toBe(false);
    });

    // 前方一致で許してしまう実装だと通ってしまう典型的な回避パターン。
    it("ホスト名の前方一致による偽装を拒否する", () => {
      expect(isAllowedMcpOrigin("https://kichijitsu.love-rox.cc.evil.example", PROD)).toBe(false);
    });

    it("opaque origin (Origin: null) を拒否する", () => {
      expect(isAllowedMcpOrigin("null", PROD)).toBe(false);
    });

    it("パースできない Origin を拒否する", () => {
      expect(isAllowedMcpOrigin("not a url", PROD)).toBe(false);
    });
  });

  describe("loopback (ローカル開発)", () => {
    it("localhost を許可する", () => {
      expect(isAllowedMcpOrigin("http://localhost:5173", "http://localhost:8787/mcp")).toBe(true);
    });

    it("127.0.0.1 を許可する", () => {
      expect(isAllowedMcpOrigin("http://127.0.0.1:8799", "http://localhost:8787/mcp")).toBe(true);
    });

    it("IPv6 loopback を許可する", () => {
      expect(isAllowedMcpOrigin("http://[::1]:8787", "http://localhost:8787/mcp")).toBe(true);
    });

    // 本番 URL に対して localhost Origin が来ても防御は緩まない
    // (本番ページから localhost を叩く正当な経路は無いが、攻撃にも使えない)。
    it("本番リクエストに対しても loopback は許可される", () => {
      expect(isAllowedMcpOrigin("http://localhost:8787", PROD)).toBe(true);
    });

    // "localhost" を含むだけの別ホストは loopback ではない。
    it("localhost を名前に含むだけの別ホストを拒否する", () => {
      expect(isAllowedMcpOrigin("https://localhost.evil.example", PROD)).toBe(false);
    });
  });
});
