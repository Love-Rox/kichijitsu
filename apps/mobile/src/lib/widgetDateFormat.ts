import { ExtensionStorage } from "@bacons/apple-targets";
import { getMeta, setMeta } from "./localDb";

/**
 * ウィジェット(StandBy 向けを含む)の日付の見せ方。この端末だけの設定。
 * 選んだ値は、アプリの DB(画面の表示用)と、App Group の UserDefaults("dateFormat"、ウィジェットが読む)に書く。
 */
export type WidgetDateFormat = "system" | "md" | "num" | "numShort";

export const DATE_FORMATS: readonly { key: WidgetDateFormat; label: string; example: string }[] = [
  { key: "system", label: "システムに合わせる", example: "端末の言語・地域の設定に従う" },
  { key: "md", label: "月日と曜日", example: "11月10日(火)" },
  { key: "num", label: "数字(年を含む)", example: "2026/11/10(火)" },
  { key: "numShort", label: "数字(月日のみ)", example: "11/10(火)" },
];

export const DEFAULT_DATE_FORMAT: WidgetDateFormat = "system";
const KEY = "widgetDateFormat";
const storage = new ExtensionStorage("group.cc.love-rox.kichijitsu");

export async function getWidgetDateFormat(): Promise<WidgetDateFormat> {
  const v = await getMeta(KEY);
  return DATE_FORMATS.some((f) => f.key === v) ? (v as WidgetDateFormat) : DEFAULT_DATE_FORMAT;
}

export async function saveWidgetDateFormat(f: WidgetDateFormat): Promise<void> {
  await setMeta(KEY, f);
  storage.set("dateFormat", f);
  ExtensionStorage.reloadWidget();
}
