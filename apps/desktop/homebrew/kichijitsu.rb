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
  version "0.1.6"
  # version を上げたら、実 DMG の sha256 に差し替える。
  # 取得方法: shasum -a 256 kichijitsu_#{version}_universal.dmg
  sha256 "f7a225a83bd59584cb1c58ca5cf6be263927325643a4df6e42fd04630a1f6cbe"

  url "https://github.com/Love-Rox/kichijitsu/releases/download/v#{version}/kichijitsu_#{version}_universal.dmg"
  name "kichijitsu"
  desc "Local-first calendar client with GitHub integration (Google Calendar counterpart)"
  homepage "https://github.com/Love-Rox/kichijitsu"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "kichijitsu.app"

  caveats <<~EOS
    kichijitsu は無署名で配布されています。Gatekeeper が初回起動をブロックするため、
    インストール後に隔離属性を外してください:
      xattr -rd com.apple.quarantine #{appdir}/kichijitsu.app
    (外さない場合は、初回起動がブロックされたら
     システム設定 → プライバシーとセキュリティ → 「このまま開く」)
    ※ Homebrew 6 はダウンロードをサンドボックスで実行するため、
      従来の --no-quarantine 指定では隔離を回避できません。

    認証に GitHub CLI を使用します: brew install gh && gh auth login
  EOS
end
