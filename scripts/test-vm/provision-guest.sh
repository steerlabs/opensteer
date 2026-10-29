#!/bin/bash
set -euo pipefail
share='/Volumes/My Shared Files'
mkdir -p "$HOME/.ssh" "$HOME/opensteer-tools"
cat "$share/provision/authorized_keys" > "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
rsync -a "$share/tools/" "$HOME/opensteer-tools/"
printf '\nexport PATH="$HOME/opensteer-tools:$PATH"\n' >> "$HOME/.zprofile"
export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOMEBREW_NO_AUTO_UPDATE=1
brew install ffmpeg go
sudo pmset -a displaysleep 0 disksleep 0 sleep 0 powernap 0
sudo defaults write /Library/Preferences/com.apple.screensaver loginWindowIdleTime -int 0
defaults -currentHost write com.apple.screensaver idleTime -int 0
defaults write com.apple.screensaver askForPassword -int 0
defaults write com.apple.screensaver askForPasswordDelay -int 2147483647
sudo defaults write /Library/Preferences/com.apple.loginwindow DisableScreenLock -bool true
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string admin
sw_vers
csrutil status
stat -f '%Su %u' /dev/console
pgrep -lf WindowServer
pmset -g
node --version
pnpm --version
xcrun swiftc --version
command -v ffmpeg go || true
brew list --versions
sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "SELECT service,client,auth_value FROM access WHERE client='/usr/libexec/sshd-keygen-wrapper';"
sudo defaults read /Library/Preferences/com.apple.loginwindow
