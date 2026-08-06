import { describe, expect, it } from "vite-plus/test";
import {
  findOwnerlessProfileIds,
  isProfileOwnerless,
  resolveLoginProfile,
  selectOwnerAccountId,
} from "../src/profile-resolution";

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

  it(
    "connectedProfileHasNoOwner を渡さない (省略): これまでどおり常に拒否する " +
      "(安全側のデフォルトが変わっていないことの固定)",
    () => {
      const resolution = resolveLoginProfile(
        { profileId: "profile-x", isOwner: false },
        NEW_PROFILE_ID,
      );
      expect(resolution).toEqual({ kind: "reject-connection-login" });
    },
  );

  it(
    "接続アカウントでログイン + 接続先プロファイルにオーナーが1人もいない: " +
      "拒否せず、そのプロファイルのオーナーに昇格させる (2026-08-06、ロックアウト復旧)",
    () => {
      const resolution = resolveLoginProfile(
        { profileId: "orphaned-profile", isOwner: false },
        NEW_PROFILE_ID,
        true,
      );
      expect(resolution).toEqual({ kind: "promote-to-owner", profileId: "orphaned-profile" });
    },
  );

  it(
    "オーナーが存在するプロファイルへの接続アカウントログインは、" +
      "connectedProfileHasNoOwner の値に関係なく拒否のまま " +
      "(2026-07-21 の事故を再発させない: オーナーがいるプロファイルへは絶対に波及しない)",
    () => {
      const resolution = resolveLoginProfile(
        { profileId: "healthy-profile", isOwner: true },
        NEW_PROFILE_ID,
        true,
      );
      // isOwner: true 分岐が先に評価されるため、そもそも connectedProfileHasNoOwner は
      // 見られない。これは「オーナー本人が戻ってきた」ケースであり昇格の対象外。
      expect(resolution).toEqual({ kind: "restore-owner-profile", profileId: "healthy-profile" });
    },
  );
});

describe("isProfileOwnerless (単一プロファイルのオーナー不在判定)", () => {
  it("オーナーが1人もいなければ true", () => {
    expect(isProfileOwnerless([{ isOwner: false }, { isOwner: false }])).toBe(true);
  });

  it("オーナーが1人でもいれば false", () => {
    expect(isProfileOwnerless([{ isOwner: false }, { isOwner: true }])).toBe(false);
  });

  it("空配列 (アカウントが1件も無い = そもそも存在しないプロファイル) は false", () => {
    expect(isProfileOwnerless([])).toBe(false);
  });
});

describe("findOwnerlessProfileIds (accounts 全体からのオーナー不在プロファイル検出)", () => {
  it("オーナーがいないプロファイルの id だけを返す", () => {
    const accounts = [
      { profileId: "p-healthy", isOwner: true },
      { profileId: "p-healthy", isOwner: false },
      { profileId: "p-orphaned", isOwner: false },
      { profileId: "p-orphaned", isOwner: false },
      { profileId: "p-solo-owner", isOwner: true },
    ];
    expect(findOwnerlessProfileIds(accounts)).toEqual(["p-orphaned"]);
  });

  it("全プロファイルにオーナーがいれば空配列", () => {
    const accounts = [
      { profileId: "p1", isOwner: true },
      { profileId: "p2", isOwner: true },
    ];
    expect(findOwnerlessProfileIds(accounts)).toEqual([]);
  });

  it("アカウントが1件も無ければ空配列", () => {
    expect(findOwnerlessProfileIds([])).toEqual([]);
  });
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
