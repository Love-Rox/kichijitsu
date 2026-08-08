import { describe, expect, it } from "vite-plus/test";
import { describeAuthError, readAuthErrorCode } from "./authErrorNotice";

describe("readAuthErrorCode", () => {
  it("returns null when there is no query string", () => {
    expect(readAuthErrorCode("")).toBeNull();
  });

  it("returns null when auth_error is absent", () => {
    expect(readAuthErrorCode("?foo=bar")).toBeNull();
  });

  it("returns null when auth_error is present but empty", () => {
    expect(readAuthErrorCode("?auth_error=")).toBeNull();
  });

  it("returns the value when auth_error is present", () => {
    expect(readAuthErrorCode("?auth_error=not_invited")).toBe("not_invited");
  });

  it("reads auth_error alongside other params without disturbing them", () => {
    expect(readAuthErrorCode("?foo=bar&auth_error=login_required&baz=qux")).toBe(
      "login_required",
    );
  });
});

describe("describeAuthError", () => {
  it("returns null for null input", () => {
    expect(describeAuthError(null)).toBeNull();
  });

  it("describes not_invited", () => {
    expect(describeAuthError("not_invited")).toMatch(/招待/);
  });

  it("describes insufficient_scope", () => {
    expect(describeAuthError("insufficient_scope")).toMatch(/権限/);
  });

  it("describes login_required", () => {
    expect(describeAuthError("login_required")).toMatch(/ログイン/);
  });

  // 未知コードを握り潰すと「サーバーが理由を送っているのに黙って捨てる」バグが再発するため、
  // ここは必ず null 以外(コードを含む汎用メッセージ)になることを固定する。
  it("never returns null for an unknown code, and includes the code", () => {
    const result = describeAuthError("github_oauth_error: access_denied");
    expect(result).not.toBeNull();
    expect(result).toContain("github_oauth_error: access_denied");
  });

  it("never returns null for another unknown code", () => {
    const result = describeAuthError("some_future_code");
    expect(result).not.toBeNull();
    expect(result).toContain("some_future_code");
  });
});
