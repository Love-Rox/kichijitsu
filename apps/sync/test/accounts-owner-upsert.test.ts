import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { ACCOUNTS_UPSERT_SQL } from "../src/routes/auth";

/**
 * routes/auth.ts の accounts UPSERT (ACCOUNTS_UPSERT_SQL) が、D1 の実体である SQLite の
 * 上で本当に意図どおり動くかを確かめる (2026-08-06、本番で2回発生したロックアウト事故の修正)。
 *
 * このリポジトリの他のテストは D1 を「実行された SQL/params を記録するだけのフェイク」で
 * 置き換えている (block-rules-route.test.ts 等) が、今回のバグの本体は SQL 文そのものの
 * 意味論 (UPSERT の DO UPDATE SET が既存行の値をどう扱うか) だったので、フェイクでは
 * 検証にならない。D1 は SQLite 互換なので、Node に組み込みの node:sqlite
 * (実験的機能ではなく Node 22.5+ で安定版、新しいライブラリの追加ではない) で実テーブルを
 * 作り、ACCOUNTS_UPSERT_SQL を auth.ts からそのまま import して直接実行する。
 *
 * accounts.id 以外の列は簡略化していない ―― is_owner の非対称な扱い (MAX) が
 * 他の列 (profile_id/email/refresh_token) の「常に上書き」と衝突しないことも
 * 合わせて確認する。
 */

function makeAccountsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      email TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      reauth_required_at INTEGER
    );
    CREATE UNIQUE INDEX idx_accounts_one_owner_per_profile ON accounts (profile_id) WHERE is_owner = 1;
  `);
  return db;
}

interface AccountRow {
  id: string;
  profile_id: string;
  email: string;
  refresh_token: string;
  is_owner: number;
  created_at: number;
  reauth_required_at: number | null;
}

function upsert(
  db: DatabaseSync,
  row: {
    id: string;
    profileId: string;
    email: string;
    refreshToken: string;
    isOwner: 0 | 1;
    createdAt: number;
  },
): void {
  db.prepare(ACCOUNTS_UPSERT_SQL).run(
    row.id,
    row.profileId,
    row.email,
    row.refreshToken,
    row.isOwner,
    row.createdAt,
  );
}

function getAccount(db: DatabaseSync, id: string): AccountRow {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) throw new Error(`account ${id} not found`);
  return row;
}

describe("ACCOUNTS_UPSERT_SQL の is_owner (実際に踏まれた本番障害の再現)", () => {
  it(
    "オーナーが「再認証」/「+アカウントを追加」(?add=1、isOwner=0 で呼ばれる) を通っても " +
      "is_owner=1 のまま (本番で2回発生したロックアウトの再現・修正確認)",
    () => {
      const db = makeAccountsDb();
      // 1. 最初のログインでオーナー行ができる (login モード、isOwner=1)。
      upsert(db, {
        id: "acc-owner",
        profileId: "profile-A",
        email: "owner@example.com",
        refreshToken: "rt-initial",
        isOwner: 1,
        createdAt: 1000,
      });
      expect(getAccount(db, "acc-owner").is_owner).toBe(1);

      // 2. 設定モーダルの「再認証」/「+ アカウントを追加」→ /auth/login?add=1 → callback。
      //    add モードは常に isOwner=0 を渡す (routes/auth.ts の `const isOwner = state.mode
      //    === "add" ? 0 : 1`)。これが本番障害の直接の引き金だった呼び出し。
      upsert(db, {
        id: "acc-owner",
        profileId: "profile-A",
        email: "owner@example.com",
        refreshToken: "rt-after-reconnect",
        isOwner: 0,
        createdAt: 1000,
      });

      const after = getAccount(db, "acc-owner");
      // 修正の核心: is_owner は 1 のまま (以前は 0 に落ちて、オーナー不在プロファイルが
      // でき、誰もログインできなくなっていた)。
      expect(after.is_owner).toBe(1);
      // 一方 refresh_token は「常に最新へ上書きする」列なので、新しいトークンに更新されている
      // ―― is_owner だけが特別扱いであり、他の列まで「既存値優先」にはしていないことの確認。
      expect(after.refresh_token).toBe("rt-after-reconnect");
    },
  );

  it("接続アカウント (isOwner=0) の新規追加は、そのとおり is_owner=0 で作られる", () => {
    const db = makeAccountsDb();
    upsert(db, {
      id: "acc-connected",
      profileId: "profile-A",
      email: "connected@example.com",
      refreshToken: "rt-1",
      isOwner: 0,
      createdAt: 2000,
    });
    expect(getAccount(db, "acc-connected").is_owner).toBe(0);
  });

  it(
    "接続アカウント (is_owner=0) がオーナー不在プロファイルへの login で昇格するとき " +
      "(promote-to-owner、isOwner=1 で呼ばれる) は 0→1 に上がる",
    () => {
      const db = makeAccountsDb();
      upsert(db, {
        id: "acc-connected",
        profileId: "profile-orphaned",
        email: "connected@example.com",
        refreshToken: "rt-1",
        isOwner: 0,
        createdAt: 2000,
      });
      expect(getAccount(db, "acc-connected").is_owner).toBe(0);

      // promote-to-owner: login モードなので isOwner=1 で呼ばれる。
      upsert(db, {
        id: "acc-connected",
        profileId: "profile-orphaned",
        email: "connected@example.com",
        refreshToken: "rt-2",
        isOwner: 1,
        createdAt: 2000,
      });
      expect(getAccount(db, "acc-connected").is_owner).toBe(1);
    },
  );

  it("profile_id / email は is_owner と異なり、常に最新の値へ上書きされる", () => {
    const db = makeAccountsDb();
    upsert(db, {
      id: "acc-owner",
      profileId: "profile-A",
      email: "old@example.com",
      refreshToken: "rt-1",
      isOwner: 1,
      createdAt: 1000,
    });
    upsert(db, {
      id: "acc-owner",
      profileId: "profile-B",
      email: "new@example.com",
      refreshToken: "rt-2",
      isOwner: 0,
      createdAt: 1000,
    });
    const after = getAccount(db, "acc-owner");
    expect(after.profile_id).toBe("profile-B");
    expect(after.email).toBe("new@example.com");
    // is_owner だけは既存値 (1) を維持する非対称な列であることの再確認。
    expect(after.is_owner).toBe(1);
  });

  it("reauth_required_at は UPSERT のたびに必ず NULL へ戻る (既存の挙動を壊していない)", () => {
    const db = makeAccountsDb();
    upsert(db, {
      id: "acc-owner",
      profileId: "profile-A",
      email: "owner@example.com",
      refreshToken: "rt-1",
      isOwner: 1,
      createdAt: 1000,
    });
    db.prepare("UPDATE accounts SET reauth_required_at = ? WHERE id = ?").run(
      1_700_000_000_000,
      "acc-owner",
    );
    expect(getAccount(db, "acc-owner").reauth_required_at).toBe(1_700_000_000_000);

    upsert(db, {
      id: "acc-owner",
      profileId: "profile-A",
      email: "owner@example.com",
      refreshToken: "rt-2",
      isOwner: 1,
      createdAt: 1000,
    });
    expect(getAccount(db, "acc-owner").reauth_required_at).toBeNull();
  });
});
