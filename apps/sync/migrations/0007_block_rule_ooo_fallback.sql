-- カレンダーブロック機能 第4段階 (docs/blocking.md、2026-07-19): 不在要求だが Workspace 非対応で busy にフォールバックしたか記録する。設定 UI の注記表示に使う。
ALTER TABLE block_rules ADD COLUMN ooo_fallback INTEGER NOT NULL DEFAULT 0;
