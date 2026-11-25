#!/usr/bin/env bash
# Applies Opensteer's alert files to one Google Cloud project: the log-based metric, the uptime
# check on the account service and every policy in policies/. Run it once per project; to change
# a policy later, delete it in the console (or `gcloud alpha monitoring policies delete`) and run
# this again, or update it with `gcloud alpha monitoring policies update --policy-from-file`.
#
# Nothing here picks a paging service. The two notification channels are configuration:
#   PAGE_CHANNEL    the channel that reaches a person at once (projects/P/notificationChannels/N)
#   DIGEST_CHANNEL  the channel read once a day
set -euo pipefail
: "${PROJECT:?Set PROJECT to the Google Cloud project that runs the account service}"
: "${ACCOUNT_HOST:?Set ACCOUNT_HOST to the account service's public host name}"
: "${PAGE_CHANNEL:?Set PAGE_CHANNEL to a notification channel name}"
: "${DIGEST_CHANNEL:?Set DIGEST_CHANNEL to a notification channel name}"
here=$(cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

gcloud logging metrics create opensteer_synthetic_run_failed --project="$PROJECT" \
  --config-from-file="$here/metrics/synthetic-run-failed.yaml"

gcloud monitoring uptime create "Opensteer account service" --project="$PROJECT" \
  --resource-type=uptime-url --resource-labels="host=$ACCOUNT_HOST,project_id=$PROJECT" \
  --protocol=https --path=/healthz --status-codes=200 --period=1 --timeout=10 \
  --regions=usa-oregon,usa-virginia,europe,asia-pacific

for policy in "$here"/policies/*.yaml; do
  name=$(basename -- "$policy")
  case $name in
    page-*) channel=$PAGE_CHANNEL ;;
    *) channel=$DIGEST_CHANNEL ;;
  esac
  sed "s|\${ACCOUNT_HOST}|$ACCOUNT_HOST|g" "$policy" > "$work/$name"
  gcloud alpha monitoring policies create --project="$PROJECT" \
    --policy-from-file="$work/$name" --notification-channels="$channel"
done
