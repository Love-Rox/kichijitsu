/**
 * 設定モーダルの「カレンダーブロック」セクション (docs/blocking.md) を担当するファイル。
 * ルール一覧・作成フォームは BlockRulesOverlay 側が持つので、ここは説明文と入口ボタンだけ。
 */
export function BlockRulesSection({ onOpenBlockRules }: { onOpenBlockRules: () => void }) {
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">カレンダーブロック</h3>
      <p className="settings-modal-section-desc">
        選んだカレンダーの予定を、別のカレンダーに「予定あり」として自動でコピーします。
      </p>
      <button type="button" className="settings-modal-add-account" onClick={onOpenBlockRules}>
        予定のブロックを設定
      </button>
    </section>
  );
}
