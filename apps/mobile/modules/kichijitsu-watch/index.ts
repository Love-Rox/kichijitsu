import { requireOptionalNativeModule } from "expo";

type WatchModule = { send(context: Record<string, string>): void };

// Expo Go や Android など、ネイティブ側が無い環境では null(何もしない)
const native = requireOptionalNativeModule<WatchModule>("KichijitsuWatch");

/** Apple Watch へ、予定やテーマを送る。Watch が無い・アプリが入っていない場合は、入った時点で送られる。 */
export function sendToWatch(context: Record<string, string>): void {
  try {
    native?.send(context);
  } catch {
    // Watch への送信の失敗で、アプリ本体を止めない
  }
}
