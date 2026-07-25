/**
 * localStorage 読み書きの共通ラッパー。
 *
 * なぜ切り出したか: 「try { window.localStorage.… } catch { フォールバック } 」という
 * 同じ形が App.tsx に8組(read 4 / write 4)、CalendarPane.tsx に4組(うち2組は
 * キー名以外 byte-identical)、githubProvider.ts に1組あった。プライベートモード等で
 * localStorage の参照そのものが throw する環境で「静かに既定値へフォールバックする」という
 * 不変条件はどのコピペにも共通なので、ここへ寄せて1箇所で守る。
 *
 * テスト都合の設計: このリポジトリのテスト環境には window が無い(useMediaQuery.test.ts と
 * 同じ事情)ため、各関数は StorageLike を任意の最終引数で受け取れるようにしてある。
 * 省略時は window.localStorage を使い、window が無い/参照が throw する環境では null 扱いに
 * なって既定値へフォールバックする ―― つまり「localStorage が使えない環境」と
 * 「テスト」がまったく同じ経路を通る。
 */

/** localStorage のうちこの層が使う部分だけの最小形(テストではフェイクを渡す) */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 使う storage を決める。明示指定が無ければ window.localStorage。
 * window が無い(テスト/SSR)・参照自体が throw する(プライバシー設定で無効化された
 * Safari 等)場合は null を返し、呼び出し側は「保存されていない」ものとして扱う。
 */
function resolveStorage(storage: StorageLike | undefined): StorageLike | null {
  if (storage) return storage;
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 保存値を読んで parse し、値が無い/不正/localStorage が使えないときは fallback を返す。
 *
 * parse は「生文字列 → 値 または null(不正なので fallback を使ってほしい)」の純関数。
 * getItem が空文字を返した場合も parse に通す(既存の `v && isView(v)` 相当の判定は
 * parse 側で行う ―― 空文字を有効値とみなす保存キーは今のところ無い)。
 */
export function readStored<T>(
  key: string,
  parse: (raw: string) => T | null,
  fallback: T,
  storage?: StorageLike,
): T {
  const s = resolveStorage(storage);
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (raw === null) return fallback;
    const parsed = parse(raw);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 文字列を保存する。localStorage が使えない環境では静かに何もしない */
export function writeStored(key: string, value: string, storage?: StorageLike): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* ignore — 保存できないだけで機能は継続する */
  }
}

/** 保存値を削除する。localStorage が使えない環境では静かに何もしない */
export function removeStored(key: string, storage?: StorageLike): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * 文字列 Set の永続化(折りたたみ状態のように「id の集合」を覚える用途)。
 * 保存形式は JSON 配列。配列でない/要素に文字列以外が混ざる壊れた値は、文字列要素だけを
 * 拾って残りを捨てる(既存の loadCollapsedAccounts/loadCollapsedGroups と同じ寛容さ)。
 */
export function readStoredStringSet(key: string, storage?: StorageLike): Set<string> {
  return readStored(
    key,
    (raw) => {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    },
    new Set<string>(),
    storage,
  );
}

/** readStoredStringSet と対の書き込み。挿入順のまま JSON 配列で保存する */
export function writeStoredStringSet(key: string, value: Set<string>, storage?: StorageLike): void {
  writeStored(key, JSON.stringify([...value]), storage);
}
