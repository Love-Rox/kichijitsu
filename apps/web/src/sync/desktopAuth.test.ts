import { describe, expect, it, vi } from "vite-plus/test";
import { buildGoogleLoginPath, startGoogleAuth, type GoogleAuthDeps } from "./desktopAuth";

/**
 * デスクトップ版 (Tauri) の外部ブラウザ OAuth の web 側 (2026-08-07)。
 * ここで一番守りたいのは **ブラウザ版/PWA の挙動が変わっていないこと** ―― 生成される
 * URL 文字列が 2026-08-06 まで AppToolbar.tsx / AppOverlays.tsx に直書きされていたものと
 * 完全に一致すること、そして `isDesktop() === false` のときに invoke も fetch も
 * 一切呼ばれないことを固定する。
 */

describe("buildGoogleLoginPath (ブラウザ経路の URL は不変)", () => {
  it("login モードは従来の '/auth/login' そのまま", () => {
    expect(buildGoogleLoginPath({ kind: "login" })).toBe("/auth/login");
  });

  it("add モードは従来の '/auth/login?add=1' そのまま", () => {
    expect(buildGoogleLoginPath({ kind: "add" })).toBe("/auth/login?add=1");
  });

  it("再連携 (login_hint 付き) も従来と1文字も変わらない", () => {
    expect(buildGoogleLoginPath({ kind: "add", loginHint: "user+tag@example.com" })).toBe(
      "/auth/login?add=1&login_hint=user%2Btag%40example.com",
    );
  });

  it("login モードでは addToken を渡しても付かない (add 専用の値なので)", () => {
    expect(buildGoogleLoginPath({ kind: "login" }, "tok")).toBe("/auth/login");
  });

  it("add モードで addToken を渡すと末尾に付く (デスクトップ経路のみ)", () => {
    expect(buildGoogleLoginPath({ kind: "add" }, "a.b.c")).toBe(
      "/auth/login?add=1&add_token=a.b.c",
    );
    expect(buildGoogleLoginPath({ kind: "add", loginHint: "a@b.c" }, "t/k=")).toBe(
      "/auth/login?add=1&login_hint=a%40b.c&add_token=t%2Fk%3D",
    );
  });
});

function makeDeps(overrides: Partial<GoogleAuthDeps> = {}): GoogleAuthDeps & {
  navigate: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  fetchAddToken: ReturnType<typeof vi.fn>;
} {
  return {
    isDesktop: () => false,
    navigate: vi.fn(),
    invoke: vi.fn(async () => undefined),
    fetchAddToken: vi.fn(async () => "add-token"),
    ...overrides,
  } as never;
}

describe("startGoogleAuth: ブラウザ版/PWA (回帰防止)", () => {
  it("login は従来どおり同一ウィンドウ遷移だけを行い、invoke も add-intent も呼ばない", async () => {
    const deps = makeDeps();
    await startGoogleAuth({ kind: "login" }, deps);
    expect(deps.navigate).toHaveBeenCalledExactlyOnceWith("/auth/login");
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(deps.fetchAddToken).not.toHaveBeenCalled();
  });

  it("add / 再連携も従来どおり (add_token を取りに行かない)", async () => {
    const deps = makeDeps();
    await startGoogleAuth({ kind: "add" }, deps);
    await startGoogleAuth({ kind: "add", loginHint: "a@b.c" }, deps);
    expect(deps.navigate.mock.calls).toEqual([
      ["/auth/login?add=1"],
      ["/auth/login?add=1&login_hint=a%40b.c"],
    ]);
    expect(deps.fetchAddToken).not.toHaveBeenCalled();
  });
});

describe("startGoogleAuth: デスクトップ版", () => {
  it("login は外部ブラウザ用のコマンドへ相対パスを渡し、同一ウィンドウ遷移はしない", async () => {
    const deps = makeDeps({ isDesktop: () => true });
    await startGoogleAuth({ kind: "login" }, deps);
    expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("open_external_login", {
      path: "/auth/login",
    });
    expect(deps.navigate).not.toHaveBeenCalled();
    // オリジン (公式インスタンスのホスト名) は web 側では組み立てない ―― セルフホスト時に
    // 漏れないよう、解決はデスクトップシェル (Rust) の責務。
    expect(String(deps.invoke.mock.calls[0]![1].path)).toMatch(/^\/auth\//);
  });

  it("add モードは先に add_token を取り、それを載せたパスを渡す", async () => {
    const deps = makeDeps({ isDesktop: () => true, fetchAddToken: vi.fn(async () => "tok-1") });
    await startGoogleAuth({ kind: "add", loginHint: "a@b.c" }, deps);
    expect(deps.fetchAddToken).toHaveBeenCalledOnce();
    expect(deps.invoke).toHaveBeenCalledExactlyOnceWith("open_external_login", {
      path: "/auth/login?add=1&login_hint=a%40b.c&add_token=tok-1",
    });
  });

  it("add_token の取得に失敗したら従来の遷移にフォールバックする (黙って止まらない)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      isDesktop: () => true,
      fetchAddToken: vi.fn(async () => {
        throw new Error("401");
      }),
    });
    await startGoogleAuth({ kind: "add" }, deps);
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledExactlyOnceWith("/auth/login?add=1");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("コマンドを持たない古いデスクトップシェル (invoke が reject) でも従来の遷移に落ちる", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      isDesktop: () => true,
      invoke: vi.fn(async () => {
        throw new Error("command not found");
      }),
    });
    await startGoogleAuth({ kind: "login" }, deps);
    expect(deps.navigate).toHaveBeenCalledExactlyOnceWith("/auth/login");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
