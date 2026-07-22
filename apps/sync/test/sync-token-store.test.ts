import { describe, expect, it, vi } from "vite-plus/test";
import {
  isStaleV2Token,
  resolveSyncTokenRead,
  V2_TOKEN_MAX_AGE_MS,
  wrapGetSyncTokenForForceFull,
  type SyncTokenRowLike,
} from "../src/core/sync-token-store";

describe("resolveSyncTokenRead", () => {
  it("deviceId 無し(旧クライアント)はレガシー共有テーブルの値をそのまま返す", () => {
    const legacyRow: SyncTokenRowLike = { sync_token: "legacy-token" };
    expect(resolveSyncTokenRead(false, null, legacyRow)).toBe("legacy-token");
    // v2 に行があっても deviceId 無しなら無視する
    expect(resolveSyncTokenRead(false, { sync_token: "v2-token" }, legacyRow)).toBe("legacy-token");
  });

  it("deviceId 無しでレガシー行も無ければ null(全同期)", () => {
    expect(resolveSyncTokenRead(false, null, null)).toBeNull();
  });

  it("v2 hit: sync_tokens_v2 に行があればその値をそのまま返す(レガシーは無視)", () => {
    const v2Row: SyncTokenRowLike = { sync_token: "device-token" };
    const legacyRow: SyncTokenRowLike = { sync_token: "legacy-token" };
    expect(resolveSyncTokenRead(true, v2Row, legacyRow)).toBe("device-token");
  });

  it("v2 hit だが sync_token が null(410 フォールバック済み)なら null を尊重する(レガシーへ falls back しない)", () => {
    const v2Row: SyncTokenRowLike = { sync_token: null };
    const legacyRow: SyncTokenRowLike = { sync_token: "legacy-token" };
    expect(resolveSyncTokenRead(true, v2Row, legacyRow)).toBeNull();
  });

  it("v2 miss → legacy seed: この端末の初回同期はレガシー共有トークンを種として使う", () => {
    const legacyRow: SyncTokenRowLike = { sync_token: "legacy-token" };
    expect(resolveSyncTokenRead(true, null, legacyRow)).toBe("legacy-token");
  });

  it("v2 miss かつレガシーも無ければ null(全同期)", () => {
    expect(resolveSyncTokenRead(true, null, null)).toBeNull();
  });
});

describe("isStaleV2Token", () => {
  it("更新から V2_TOKEN_MAX_AGE_MS を超えていれば stale", () => {
    const updatedAt = 0;
    const now = V2_TOKEN_MAX_AGE_MS + 1;
    expect(isStaleV2Token(updatedAt, now)).toBe(true);
  });

  it("ちょうど V2_TOKEN_MAX_AGE_MS 経過(境界)は stale ではない", () => {
    const updatedAt = 0;
    const now = V2_TOKEN_MAX_AGE_MS;
    expect(isStaleV2Token(updatedAt, now)).toBe(false);
  });

  it("更新から間もなければ stale ではない", () => {
    expect(isStaleV2Token(1_000, 2_000)).toBe(false);
  });
});

describe("wrapGetSyncTokenForForceFull", () => {
  it("forceFull=false なら元の getSyncToken をそのまま返す(呼ばれ方も含めて透過)", async () => {
    const getSyncToken = vi.fn(async (calendarId: string) => `token-for-${calendarId}`);

    const wrapped = wrapGetSyncTokenForForceFull(getSyncToken, false);
    const result = await wrapped("cal-1");

    expect(result).toBe("token-for-cal-1");
    expect(getSyncToken).toHaveBeenCalledOnce();
    expect(getSyncToken).toHaveBeenCalledWith("cal-1");
  });

  it("forceFull=true なら元の getSyncToken を一切呼ばず常に null を返す", async () => {
    const getSyncToken = vi.fn(async () => "should-not-be-read");

    const wrapped = wrapGetSyncTokenForForceFull(getSyncToken, true);
    const result = await wrapped("cal-1");

    expect(result).toBeNull();
    expect(getSyncToken).not.toHaveBeenCalled();
  });
});
