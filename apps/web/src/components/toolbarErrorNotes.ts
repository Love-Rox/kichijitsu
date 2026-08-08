/**
 * ツールバーの注意文言 (同期失敗・保存失敗・Google 再認証が必要・OAuth 連携拒否) を
 * 組み立てる純ロジック。toolbarMenuItems.ts と同じ理由 (この web アプリにはコンポーネント
 * テストの土台が無いため、React に依存しない .ts に切り出してテストで固定する) で
 * AppToolbar.tsx から分離した。
 *
 * ここで作った文字列はそのまま2箇所で使われる: 広幅ヘッダーの `.sync-error` スパン、
 * 狭幅の ToolbarMenu 内 `.toolbar-menu-note`(どちらも既存、AppToolbar.tsx 側の配線)。
 * どちらも「設定モーダルを開かなくても気づける場所」―― Google 再認証待ちは同期が
 * 完全に止まる深刻な状態 (2026-08-06 本番障害対応) なので、設定モーダルの中だけでなく
 * ここにも出す。実際の再認証操作 (再連携ボタン) は設定モーダルの AccountsSection に
 * 置いてある (対象アカウントが複数ありうる一覧 UI のほうが導線として自然なため)。
 */
export interface ToolbarErrorNotesInput {
  /** useCalendarSync の syncStatus === "error" */
  syncFailed: boolean;
  /** useEventMutations の saveError (元に戻した保存失敗) */
  saveFailed: boolean;
  /** me.accounts のうち reauthRequired な (Google の再認証が必要な) アカウントのメール一覧 */
  reauthRequiredEmails: readonly string[];
  /**
   * OAuth (Google/GitHub) の却下理由 (auth/authErrorNotice.ts の describeAuthError の
   * 戻り値をそのまま渡す)。連携が却下された直後に APP_URL へ戻ってきたときだけ非 null で、
   * その後は次のリロードまで出しっぱなしになる (App.tsx が持つ1回きりの state)。
   *
   * 他の3つと同じく **optional にしない** ―― この項目が生まれた原因が「サーバーは理由を
   * 送っていたのに受け手がどこにも無かった」ことなので、省略できる形にすると、新しい
   * 呼び出し側が黙って渡し忘れて同じ沈黙が再発する。渡さないなら null と明示させる。
   */
  authErrorNote: string | null;
}

export function buildToolbarErrorNotes(input: ToolbarErrorNotesInput): string[] {
  const notes: string[] = [];
  if (input.syncFailed) notes.push("同期失敗");
  if (input.saveFailed) notes.push("保存失敗（元に戻しました）");
  for (const email of input.reauthRequiredEmails) {
    notes.push(`Google の再認証が必要です (${email})`);
  }
  if (input.authErrorNote) notes.push(input.authErrorNote);
  return notes;
}
