#!/bin/bash
set -euo pipefail
work="${1:?Pass the fixture build directory}"
support=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# SwiftPM supplies embedded Apple data resources and the shared signing module.
bash "$support/link-owner-view-helper.sh" --dependencies "$work"
