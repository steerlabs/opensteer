#!/usr/bin/env python3
"""Checks the alert files the way gcloud reads them, creating nothing anywhere.

`gcloud alpha monitoring policies create --policy-from-file` and
`gcloud logging metrics create --config-from-file` parse a file into the API's message with
gcloud's own code (googlecloudsdk.command_lib.monitoring.util.MessageFromString). This runs that
same code on every file here, with no project, no account and no network, and is stricter than
gcloud in two ways the API would refuse later: a field the message does not have, and an enum
value it does not know, are errors.

Run it with gcloud's own Python:
  "$(gcloud info --format='value(basic.python_location)')" deploy/monitoring/validate.py
"""

import glob
import os
import re
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
sdk = subprocess.check_output(
    ["gcloud", "info", "--format=value(installation.sdk_root)"], text=True
).strip()
sys.path[:0] = [os.path.join(sdk, "lib"), os.path.join(sdk, "lib", "third_party")]

from apitools.base.protorpclite import messages as protorpc  # noqa: E402
from googlecloudsdk.api_lib.util import apis  # noqa: E402
from googlecloudsdk.command_lib.monitoring import util  # noqa: E402

monitoring = apis.GetMessagesModule("monitoring", "v3")
logging = apis.GetMessagesModule("logging", "v2")
# Placeholders apply.sh fills in.
example = {"ACCOUNT_HOST": "account.example.com"}
duration = re.compile(r"^\d+s$")


def problems(message, path):
    found = []
    for name in message.all_unrecognized_fields():
        found.append(f"{path}.{name}: not a field of {type(message).__name__}")
    for field in message.all_fields():
        values = message.get_assigned_value(field.name)
        if values is None:
            continue
        for value in values if field.repeated else [values]:
            where = f"{path}.{field.name}"
            if isinstance(value, protorpc.Message):
                found += problems(value, where)
            elif isinstance(field, protorpc.EnumField) and not isinstance(value, protorpc.Enum):
                found.append(f"{where}: {value!r} is not one of its values")
            elif isinstance(value, str) and field.name in (
                "alignmentPeriod",
                "duration",
                "period",
                "autoClose",
            ) and not duration.match(value):
                found.append(f"{where}: {value!r} is not a duration in seconds")
    return found


def parse(path, message_type, display):
    text = open(path, encoding="utf-8").read()
    for key, value in example.items():
        text = text.replace("${" + key + "}", value)
    if "${" in text:
        return [f"{path}: a placeholder apply.sh does not fill"]
    try:
        message = util.MessageFromString(text, message_type, display)
    except Exception as error:  # gcloud's own refusal, as it would print it
        return [f"{path}: {error}"]
    return problems(message, os.path.relpath(path, here))


failures = []
policies = sorted(glob.glob(os.path.join(here, "policies", "*.yaml")))
metrics = sorted(glob.glob(os.path.join(here, "metrics", "*.yaml")))
for path in policies:
    failures += parse(path, monitoring.AlertPolicy, "AlertPolicy")
for path in metrics:
    failures += parse(path, logging.LogMetric, "LogMetric")
pages = [p for p in policies if os.path.basename(p).startswith("page-")]
if len(pages) != 3:
    failures.append(f"Three alerts page; found {len(pages)}")
for failure in failures:
    print(failure)
print(f"{len(policies)} policies and {len(metrics)} metrics read; {len(failures)} problems")
sys.exit(1 if failures else 0)
