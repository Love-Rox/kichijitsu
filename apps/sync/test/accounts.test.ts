import { describe, expect, it } from "vite-plus/test";
import {
  isAccountInProfile,
  resolveDisconnectTargets,
  shouldClearSessionAfterDisconnect,
  type AccountMembership,
} from "../src/accounts";

describe("isAccountInProfile", () => {
  it("allows an account that belongs to the caller profile", () => {
    expect(isAccountInProfile({ profile_id: "profile-a" }, "profile-a")).toBe(true);
  });

  it("rejects an account that belongs to a different profile", () => {
    expect(isAccountInProfile({ profile_id: "profile-b" }, "profile-a")).toBe(false);
  });

  it("rejects a non-existent account (null row)", () => {
    expect(isAccountInProfile(null, "profile-a")).toBe(false);
  });
});

describe("resolveDisconnectTargets", () => {
  // acc-1 が owner (身元)、acc-2 は接続 (同期専用) という前提の2アカウント構成。
  const PROFILE_ACCOUNTS: AccountMembership[] = [
    { id: "acc-1", isOwner: true },
    { id: "acc-2", isOwner: false },
  ];
  const ALL_IDS = PROFILE_ACCOUNTS.map((a) => a.id);

  it("targets just the requested account when it is a non-owner (connected) account", () => {
    expect(resolveDisconnectTargets({ accountId: "acc-2" }, PROFILE_ACCOUNTS)).toEqual(["acc-2"]);
  });

  it("escalates to the whole profile when the requested account is the owner (safe default)", () => {
    // オーナーだけを消して接続アカウントが宙に浮く状態を防ぐため、オーナー解除は
    // プロファイル全体の解除に格上げされる。
    expect(resolveDisconnectTargets({ accountId: "acc-1" }, PROFILE_ACCOUNTS)).toEqual(ALL_IDS);
  });

  it("returns null (ownership failure) when the requested account is not in the profile", () => {
    expect(
      resolveDisconnectTargets({ accountId: "someone-elses-account" }, PROFILE_ACCOUNTS),
    ).toBeNull();
  });

  it("targets every account in the profile when accountId is omitted", () => {
    expect(resolveDisconnectTargets({}, PROFILE_ACCOUNTS)).toEqual(ALL_IDS);
  });
});

describe("shouldClearSessionAfterDisconnect", () => {
  it("keeps the session when at least one account remains (single-account disconnect)", () => {
    expect(shouldClearSessionAfterDisconnect(1)).toBe(false);
  });

  it("clears the session when no accounts remain (full disconnect)", () => {
    expect(shouldClearSessionAfterDisconnect(0)).toBe(true);
  });
});
