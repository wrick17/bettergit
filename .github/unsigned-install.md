
## Install

**Unsigned build.** Apple has not notarized this app, so macOS blocks it the first time you open it.

1. Move BetterGit to Applications and try to open it.
2. Open System Settings > Privacy & Security. Under Security, click **Open Anyway** and enter your login password. The button appears for about an hour after the blocked attempt.

Or clear the quarantine flag in Terminal: `xattr -dr com.apple.quarantine /Applications/BetterGit.app`
