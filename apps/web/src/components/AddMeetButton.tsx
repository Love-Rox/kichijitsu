import { useState } from "react";
import { MeetingProviderIcon } from "./meetingProviderIcon";
import "./AddMeetButton.css";

/**
 * 詳細カードの「Google Meet を追加」ボタン。押すと会議を作る依頼を送り、成功したら(リンクが入って)
 * この欄は参加リンクに置き換わる。失敗したら理由をカード内に出す。繰り返しの予定は、シリーズ全体に付く。
 */
export function AddMeetButton({
  isRecurring,
  onAddMeet,
}: {
  isRecurring: boolean;
  onAddMeet: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    onAddMeet()
      .catch(() => setError("会議を追加できませんでした。もう一度お試しください。"))
      .finally(() => setPending(false));
  };

  return (
    <div className="event-detail-add-meet">
      <button type="button" className="event-detail-add-meet-button" onClick={add} disabled={pending}>
        <MeetingProviderIcon provider="meet" width={12} height={12} />
        {pending ? "追加しています…" : "Google Meet を追加"}
      </button>
      {isRecurring && <div className="event-detail-add-meet-note">繰り返しの予定すべてに付きます</div>}
      {error && (
        <div className="event-detail-colors-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
