import { describe, expect, it } from "vite-plus/test";
import { resolveLoginProfile, selectOwnerAccountId } from "../src/profile-resolution";

describe("resolveLoginProfile (login モードのプロファイル解決)", () => {
  const NEW_PROFILE_ID = "new-profile-uuid";

  it("オーナーでログイン: 既存のオーナープロファイルへ復帰する", () => {
    const resolution = resolveLoginProfile(
      { profileId: "profile-own", isOwner: true },
      NEW_PROFILE_ID,
    );
    expect(resolution).toEqual({ kind: "restore-owner-profile", profileId: "profile-own" });
  });

  it("未連携 (初めて見る Google アカウント) でログイン: 新規プロファイルを作る", () => {
    const resolution = resolveLoginProfile(null, NEW_PROFILE_ID);
    expect(resolution).toEqual({ kind: "new-profile", profileId: NEW_PROFILE_ID });
  });

  it(
    "接続アカウント (他人のプロファイルに is_owner=0 で属する) でログイン: " +
      "プロファイルを作らず、ログインを拒否する (2026-07-21 のバグ修正の核心)",
    () => {
      const resolution = resolveLoginProfile(
        { profileId: "someone-elses-profile", isOwner: false },
        NEW_PROFILE_ID,
      );
      expect(resolution).toEqual({ kind: "reject-connection-login" });
    },
  );
});

describe("selectOwnerAccountId (migration 0004 の「最古=owner」ルールの純関数版)", () => {
  it("1件だけなら、そのアカウントが owner", () => {
    expect(selectOwnerAccountId([{ id: "acc-1", createdAt: 100 }])).toBe("acc-1");
  });

  it("最古 (created_at 最小) のアカウントを owner に選ぶ", () => {
    const accounts = [
      { id: "acc-added-later", createdAt: 200 },
      { id: "acc-original", createdAt: 100 },
    ];
    expect(selectOwnerAccountId(accounts)).toBe("acc-original");
  });

  it("created_at が同着なら id の昇順で決定的に選ぶ", () => {
    const accounts = [
      { id: "zzz", createdAt: 100 },
      { id: "aaa", createdAt: 100 },
    ];
    expect(selectOwnerAccountId(accounts)).toBe("aaa");
  });

  it("空配列なら null", () => {
    expect(selectOwnerAccountId([])).toBeNull();
  });
});
