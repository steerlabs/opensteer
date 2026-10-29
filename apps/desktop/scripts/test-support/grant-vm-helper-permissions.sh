#!/bin/bash
# The golden grants only sshd-keygen-wrapper, whose grants SSH-started processes
# inherit. The helper LaunchServices starts is its own responsible process, so a
# disposable guest, which has SIP disabled, grants it by bundle identifier. On any
# other Mac the person grants the helper; this changes nothing there.
set -euo pipefail
[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || exit 0
for service in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent; do
  sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,flags,last_modified) VALUES ('$service','com.opensteer.computer-use',0,2,4,1,'UNUSED',0,strftime('%s','now'));"
done
