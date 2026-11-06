import { apiFetch } from "./api";
import type { AccountCalendars } from "./calendarData";
import { getMeta, setMeta } from "./localDb";

/**
 * カレンダーの表示/非表示を切り替える。保存先は Web・デスクトップ版と同じサーバー
 * (PUT /api/visible-calendars)なので、端末間で選択が揃う。アカウントごとに、表示するカレンダー
 * の id の全体を送って上書きする。呼び出し側は、成功後に再読み込みして、新しく表示するカレンダーの
 * 同期と、隠したカレンダーの掃除を行う。
 */
export async function setCalendarVisible(
  account: AccountCalendars,
  calendarId: string,
  visible: boolean,
): Promise<void> {
  const current = account.calendars.map((c) => c.id);
  const next = visible
    ? [...new Set([...current, calendarId])]
    : current.filter((id) => id !== calendarId);
  const res = await apiFetch<unknown>("/api/visible-calendars", {
    method: "PUT",
    body: JSON.stringify({ accountId: account.accountId, calendarIds: next }),
  });
  if (res === null) throw new Error("ログインが切れています");
}

/** 新しい予定の作成先の既定のカレンダー。この端末だけの設定で、`${accountId}:${calendarId}` の形(writeTargetKey と同じ)。 */
const DEFAULT_CALENDAR_KEY = "defaultCalendar";

export async function getDefaultCalendar(): Promise<string | null> {
  return getMeta(DEFAULT_CALENDAR_KEY);
}

export async function setDefaultCalendar(key: string | null): Promise<void> {
  // meta は値が空文字なら「未設定(自動)」として読む
  await setMeta(DEFAULT_CALENDAR_KEY, key ?? "");
}
