# Governance

Opensteer is maintained by the maintainers listed in [MAINTAINERS.md](MAINTAINERS.md).

## Decision Model

We use lazy consensus for routine changes:

- A maintainer proposes a change in an issue or pull request.
- If there is no substantiated objection within 72 hours, the change may proceed.
- Any maintainer may request more discussion for high-impact changes.

## What Requires Maintainer Approval

The following always require maintainer approval before merge:

- Public API and CLI behavior changes.
- Dependency additions or major version upgrades.
- Security-related behavior and policy changes.
- Release workflow, publishing, and governance updates.

## Dispute Resolution

If contributors disagree:

1. Discuss in the PR/issue with concrete tradeoffs and alternatives.
2. Escalate to maintainers for final decision if consensus is not reached.
3. For conduct issues, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Release Authority

Only maintainers may create release tags and publish npm releases.
Releases are created by GitHub Actions workflows from tagged commits.
