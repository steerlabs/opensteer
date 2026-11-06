---
name: integrations
description: Discover/call service operations, request account setup or access, and manage existing integrations.
---

# Opensteer Integrations

Use a fitting integration for service account and API work, including built-in connectors, remote MCP servers, proposed APIs and Agent Plugins. Find an operation that meets the goal, request any missing access from the person, and verify the result on the intended account.

Select accounts by `connectionId`, never display name. Search shows each operation's `input`, so call it directly with its `name` and the `connectionId` as `account`. The Host checks the current account and grant at execution.

Credentials belong in the Request UI. Except for SMS/email codes for a sign-in the person asked for (see boundaries), never collect or retrieve service secrets yourself, and never bypass denied access with another account or transport. Mac apps and Android phones use `app()` and `phone()` in the `computer` tool (opensteer:computer-use), never with `integration_call`.

Use `integration_manage` to list, disconnect, uninstall or revoke grants directly within
full-access and reach. `channel_manage` lists/revokes bindings or pauses/resumes existing
connections. These tools cannot create accounts, enter credentials or grant access.

Read only the reference needed for the work:

- [Discovery](references/discovery.md) when finding operations or interpreting readiness and paging.
- [Operations](references/operations.md) when an operation needs more detail than search shows, or repairing a schema or account error.
- [Requests](references/requests.md) when connecting, installing or requesting access.
- [Proposals](references/proposals.md) when the catalog has no fitting integration.
- [Boundaries](references/boundaries.md) when handling credentials, computer-hosted services or Trigger access.
