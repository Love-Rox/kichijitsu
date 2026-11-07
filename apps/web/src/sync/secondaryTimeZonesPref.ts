/**
 * 並べるタイムゾーンの設定(複数タイムゾーン、2026-11-07)。localStorage に JSON 配列で保存し、
 * 変えると、時刻軸を描いている画面がすぐ再描画される(useSyncExternalStore)。
 * 検証と正規化は layout/secondaryTimeZones.ts の純関数が持つ。テーマ設定と同じく、好みの設定なので、
 * ログアウトでは消さない(sync/logoutLocalStorage.ts の例外)。
 */
import { useMemo, useSyncExternalStore } from "react";
import { readStored, removeStored, writeStored } from "../layout/localStore";
import {
  MAX_SECONDARY_TIME_ZONES,
  normalizeSecondaryTimeZones,
  parseSecondaryTimeZones,
} from "../layout/secondaryTimeZones";

export const SECONDARY_TZ_STORAGE_KEY = "kichijitsu:secondaryTimeZones";

const listeners = new Set<() => void>();
/** useSyncExternalStore は、同じ値なら同じ参照を返す必要がある。保存文字列をキーにして、一覧を使い回す。 */
let cachedRaw: string | null | undefined;
let cachedList: string[] = [];

function readRaw(): string | null {
  return readStored<string | null>(SECONDARY_TZ_STORAGE_KEY, (raw) => raw, null);
}

function snapshot(): string[] {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = raw === null ? [] : parseSecondaryTimeZones(raw);
  }
  return cachedList;
}

/** 保存された、並べるタイムゾーン(基準のタイムゾーンとの重複は、ここでは除かない)。 */
export function getSecondaryTimeZones(): string[] {
  return snapshot();
}

/** 並べるタイムゾーンを保存して、すぐ反映する。空なら保存値ごと消す。 */
export function setSecondaryTimeZones(list: string[]): void {
  const normalized = normalizeSecondaryTimeZones(list);
  if (normalized.length === 0) removeStored(SECONDARY_TZ_STORAGE_KEY);
  else writeStored(SECONDARY_TZ_STORAGE_KEY, JSON.stringify(normalized));
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 画面用: 並べるタイムゾーン。基準(端末)のタイムゾーンと同じものは除く。 */
export function useSecondaryTimeZones(primaryTimeZone: string): string[] {
  const all = useSyncExternalStore(subscribe, snapshot, () => []);
  return useMemo(
    () => all.filter((id) => id !== primaryTimeZone).slice(0, MAX_SECONDARY_TIME_ZONES),
    [all, primaryTimeZone],
  );
}
