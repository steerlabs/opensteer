# Alerts for Opensteer's own services

These files are how Opensteer, the company, learns that a service it runs is going wrong: the
account service (`apps/control-plane`), the provisioner (`apps/home-provisioner`) and the Cloud
Computers they run. They are Google Cloud Monitoring alert policies kept as files and applied
with `gcloud`. No other service is involved: the account service and the provisioner run on GKE,
so their logs already go to Cloud Logging. What a person's own devices and self-hosted Homes
send, and when they send it, is in [docs/architecture.md](../../docs/architecture.md),
"Problems and reports".

Every alert is written against a stable event name in `jsonPayload.event`. The account service's
names are listed in `apps/control-plane/src/server/events.ts`, and the provisioner's in
`apps/home-provisioner/src/http.ts` (`provisionerFailure`). Each policy file starts with the one
line saying why it exists and names the runbook section to open
([docs/cloud-computer-operations.md](../../docs/cloud-computer-operations.md)).
`apps/control-plane/src/server/monitoring-files.test.ts` fails if a policy names an event that no
service writes, or a runbook section that does not exist.

## What pages, and what waits for the daily digest

Three alerts page, because a person is hurt by them now:

| File                                        | When                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `policies/page-paid-not-ready.yaml`         | A person paid and their Cloud Computer failed to set up, or is not ready 30 minutes after checkout |
| `policies/page-account-down.yaml`           | The account service's `/healthz` fails from more than one region for two minutes                   |
| `policies/page-synthetic-failed-twice.yaml` | The synthetic purchase (`scripts/synthetic-cloud-computer.mjs`) failed in two runs in a row        |

Everything else goes to the digest channel at most once a day per alert (`policies/digest-*.yaml`):
a failed setup with its cause, a failed claim, a failed billing step, a deleted Cloud Computer that
needs a look in Stripe, an overdue backup, pending backup erasure, a nearly empty pool, a Cloud
Computer that reports a problem or stopped reporting, one whose run of outages has lasted 30 minutes with none paged now,
and a failing provisioner pass.

## Heartbeats

A heartbeat is a plain HTTP GET at the end of each successful pass of a job that must run. Point
each one at a dead-man check of any service that accepts a GET, and give that check the period
below. It is configuration; nothing in the code names a vendor.

| Setting                                    | Sent                                                 | Period | Grace  |
| ------------------------------------------ | ---------------------------------------------------- | ------ | ------ |
| `OPENSTEER_CLOUD_COMPUTER_HEARTBEAT_URL`   | after each billing pass with no failure (every 60 s) | 1 min  | 10 min |
| `OPENSTEER_HOME_PROVISIONER_HEARTBEAT_URL` | after each provisioner tick with no failure (10 s)   | 1 min  | 10 min |
| `OPENSTEER_SYNTHETIC_HEARTBEAT_URL`        | after each passing synthetic purchase (every 6 h)    | 6 h    | 7 h    |

The billing pass also runs the watch that writes `account.cloud_computer.not_ready`,
`unstable`, `backup_overdue` and `pool.low`, so its heartbeat says the watch runs too. A Cloud Computer's own
backups need no heartbeat each: the watch reports a ready computer with no backup for 36 hours.

## Notification channels

A channel is configuration, made once per project, in the console or with `gcloud`, for example
an email address for the digest:

```sh
gcloud beta monitoring channels create --project="$PROJECT" \
  --display-name="Opensteer digest" --type=email --channel-labels=email_address=ops@example.com
gcloud beta monitoring channels list --project="$PROJECT" --format='value(name,displayName)'
```

The paging channel is whatever reaches the person on call: a phone app, SMS or a webhook to a
paging service. Use its `projects/P/notificationChannels/N` name below.

## Applying

```sh
PROJECT=opensteer-production ACCOUNT_HOST=account.opensteer.com \
PAGE_CHANNEL=projects/opensteer-production/notificationChannels/111 \
DIGEST_CHANNEL=projects/opensteer-production/notificationChannels/222 \
  deploy/monitoring/apply.sh
```

`apply.sh` runs exactly these commands:

1. `gcloud logging metrics create opensteer_synthetic_run_failed --config-from-file=metrics/synthetic-run-failed.yaml`
2. `gcloud monitoring uptime create "Opensteer account service" --resource-type=uptime-url
--resource-labels=host=$ACCOUNT_HOST,project_id=$PROJECT --protocol=https --path=/healthz
--status-codes=200 --period=1 --timeout=10 --regions=usa-oregon,usa-virginia,europe,asia-pacific`
3. for each `policies/*.yaml`, with `${ACCOUNT_HOST}` filled in:
   `gcloud alpha monitoring policies create --policy-from-file=<file> --notification-channels=<page or digest channel>`

Run it once per project: it is not idempotent, and a second run stops at the metric with "already exists". To change a policy, update it with
`gcloud alpha monitoring policies update <name> --policy-from-file=<file>`, or delete it and run
the script again.

## Checking the files

```sh
"$(gcloud info --format='value(basic.python_location)')" deploy/monitoring/validate.py
```

`validate.py` parses every file with gcloud's own code, the code behind `--policy-from-file` and
`--config-from-file`. It needs no project, account or network and creates nothing. It is stricter
than gcloud is before sending: a field the API message does not have, an enum value it does not
know and a duration not in seconds are all errors. It also checks that exactly three alerts page.
It cannot check that a Cloud Logging filter matches; the event names are checked by
`monitoring-files.test.ts`.
