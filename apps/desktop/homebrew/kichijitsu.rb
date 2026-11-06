# Homebrew cask テンプレート (source of truth はこのファイル)
#
# 実際に配布する cask は Love-Rox/homebrew-tap の Casks/kichijitsu.rb に
# 配置する。初回リリース後、このファイルの内容を Love-Rox/homebrew-tap の
# Casks/kichijitsu.rb にコピーし、`sha256` をリリースされた DMG の実ハッシュに
# 差し替えてから commit する（手順は docs/desktop.md「リリース/配布手順」参照）。
#
# version を上げるたびに、この2箇所 (このファイル / tap 側) を同じ内容に
# 保つこと。

cask "kichijitsu" do
  version "0.1.8"
  # version を上げたら、実 DMG の sha256 に差し替える。
  # 取得方法: shasum -a 256 kichijitsu_#{version}_universal.dmg
  sha256 "d3f8bd9f73b02d009bc0c057081a4159c0c22d4c59c6c9ce33c6cfe21191f99e"

  url "https://github.com/Love-Rox/kichijitsu/releases/download/v#{version}/kichijitsu_#{version}_universal.dmg"
  name "kichijitsu"
  desc "Local-first calendar client with GitHub integration (Google Calendar counterpart)"
  homepage "https://github.com/Love-Rox/kichijitsu"

  livecheck do
    url :url
    strategy :github_latest
  end

  # アプリ自身が起動中に更新を確認して自動で差し替える(apps/desktop/src-tauri/src/updater.rs)。
  # 宣言しておくと、`brew upgrade` が自動更新するアプリを重ねて更新しなくなる
  # (更新したいときは `brew upgrade --greedy`)。
  auto_updates true

  depends_on macos: :ventura

  app "kichijitsu.app"

  caveats <<~EOS
    kichijitsu は Developer ID で署名し、Apple の公証を受けています。
    起動中に自動で更新を確認し、新しい版を見つけると、取得してから通知します。
    トレイのメニュー「アップデートを確認」で再起動すると反映されます。

    認証に GitHub CLI を使用します: brew install gh && gh auth login
  EOS
end
