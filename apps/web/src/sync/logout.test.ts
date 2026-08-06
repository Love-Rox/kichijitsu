import { describe, expect, it } from "vite-plus/test";
import { LogoutError, performLogout, type PerformLogoutDeps } from "./logout";
import type { EnumerableStorage } from "./logoutLocalStorage";
import type { CheckedFetch } from "./httpJson";

/** logoutLocalStorage.test.ts の stub と同じ最小実装 */
function stubStorage(initial: Record<string, string>): EnumerableStorage & {
  snapshot(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

function baseDeps(overrides: Partial<PerformLogoutDeps> = {}): {
  deps: PerformLogoutDeps;
  fetchCalls: { path: string; init?: RequestInit }[];
  clearLocalDbCalls: number;
} {
  const fetchCalls: { path: string; init?: RequestInit }[] = [];
  const checkedFetch: CheckedFetch = (path, init) => {
    fetchCalls.push({ path, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  let clearLocalDbCalls = 0;
  const deps: PerformLogoutDeps = {
    storage: stubStorage({ "kichijitsu:view": "week", "kichijitsu:theme": "dark" }),
    clearLocalDb: () => {
      clearLocalDbCalls += 1;
      return Promise.resolve();
    },
    checkedFetch,
    ...overrides,
  };
  return { deps, fetchCalls, clearLocalDbCalls };
}

describe("performLogout", () => {
  it("成功時: localStorage を掃除 → IndexedDB 削除 → POST /auth/logout の順で行う", async () => {
    const order: string[] = [];
    const storage = stubStorage({ "kichijitsu:view": "week", "kichijitsu:theme": "dark" });
    const fetchCalls: { path: string; init?: RequestInit }[] = [];
    const checkedFetch: CheckedFetch = (path, init) => {
      order.push("fetch");
      fetchCalls.push({ path, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const clearLocalDb = () => {
      order.push("clearLocalDb");
      // この時点で localStorage の掃除は既に終わっているはず(同期的に先に走るため)
      expect(storage.snapshot()).toEqual({ "kichijitsu:theme": "dark" });
      return Promise.resolve();
    };

    await performLogout({ storage, clearLocalDb, checkedFetch });

    expect(order).toEqual(["clearLocalDb", "fetch"]);
    expect(fetchCalls).toEqual([{ path: "/auth/logout", init: { method: "POST" } }]);
    // kichijitsu:theme だけ残り、kichijitsu:view は消えている
    expect(storage.snapshot()).toEqual({ "kichijitsu:theme": "dark" });
  });

  it("端末データの削除 (IndexedDB) が失敗したら LogoutError(stage: local-data) を投げ、サーバーは叩かない", async () => {
    const boom = new Error("indexedDB.deleteDatabase blocked");
    const { deps, fetchCalls } = baseDeps({ clearLocalDb: () => Promise.reject(boom) });

    const err = await performLogout(deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LogoutError);
    expect((err as LogoutError).stage).toBe("local-data");
    expect((err as LogoutError).cause).toBe(boom);
    // ローカルデータの削除が終わっていないので、サーバーへは要求を送らない
    // (順序の要件: セッションを切る前に端末データを消し切る)
    expect(fetchCalls).toEqual([]);
  });

  it("localStorage の削除自体が例外を投げても LogoutError(stage: local-data) になる", async () => {
    const throwingStorage: EnumerableStorage = {
      get length(): number {
        throw new Error("storage access denied");
      },
      key: () => null,
      removeItem: () => {},
    };
    const { deps, fetchCalls } = baseDeps({ storage: throwingStorage });

    const err = await performLogout(deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LogoutError);
    expect((err as LogoutError).stage).toBe("local-data");
    expect(fetchCalls).toEqual([]);
  });

  it("端末データの削除は成功したがサーバー要求が失敗したら LogoutError(stage: session)", async () => {
    const checkedFetch: CheckedFetch = () => Promise.resolve(new Response(null, { status: 500 }));
    const { deps } = baseDeps({ checkedFetch });

    const err = await performLogout(deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LogoutError);
    expect((err as LogoutError).stage).toBe("session");
    // ローカルデータは既に消えている(=もう一度押しても二重に消そうとするだけで安全)
    expect((deps.storage as ReturnType<typeof stubStorage>).snapshot()).toEqual({
      "kichijitsu:theme": "dark",
    });
  });

  it("fetch 自体の例外(オフライン)も LogoutError(stage: session) に包む", async () => {
    const offlineErr = new TypeError("Failed to fetch");
    const { deps } = baseDeps({ checkedFetch: () => Promise.reject(offlineErr) });

    const err = await performLogout(deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LogoutError);
    expect((err as LogoutError).stage).toBe("session");
    expect((err as LogoutError).cause).toBe(offlineErr);
  });
});
