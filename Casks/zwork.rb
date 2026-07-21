cask "zwork" do
  version "0.5.0-beta.12"
  sha256 :no_check

  url "https://github.com/Ryz3nPlayZ/zWork/releases/download/v#{version}/zWork-macos-universal.dmg"
  name "zWork"
  desc "Desktop AI agent that runs on your schedule and works across your apps"
  homepage "https://github.com/Ryz3nPlayZ/zWork"

  livecheck do
    url "https://github.com/Ryz3nPlayZ/zWork/releases"
    strategy :github_latest
  end

  app "zWork.app"

  zap trash: [
    "~/.zwork",
    "~/Library/Application Support/com.zwork.desktop",
    "~/Library/Logs/zWork",
    "~/Library/Preferences/com.zwork.desktop.plist",
    "~/Library/Saved Application State/com.zwork.desktop.savedState",
  ]
end
