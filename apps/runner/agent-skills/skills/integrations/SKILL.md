---
name: integrations
description: Find and use connected service operations, connect an account, or propose a missing MCP, OpenAPI or GraphQL integration.
---

# Opensteer Integrations

Use a fitting integration for service account and API work, including built-in connectors, remote MCP servers, proposed APIs and Agent Plugins. Find an operation that meets the goal, obtain any missing access, and verify the result on the intended account.

Select accounts by `connectionId`, never display name. A `toolRef` binds an operation to a grant and schema; copy it unchanged. Describe a new ref before calling it; call an already-described operation directly. The Host checks current account, grant and schema at execution, without enforcing describe/call order.

Credentials and consent belong in the Request UI. Never collect or retrieve service secrets yourself, and never bypass denied access with another account or transport. Mac apps and Android phones use `app()` and `phone()` in the `computer` tool (opensteer:computer-use), never with `integration_call`.

Read only the reference needed for the work:

- [Discovery](references/discovery.md) when finding operations or interpreting readiness and paging.
- [Operations](references/operations.md) before using a new ref or repairing a schema or account error.
- [Requests](references/requests.md) when connecting, installing or requesting access.
- [Proposals](references/proposals.md) when the catalog has no fitting integration.
- [Boundaries](references/boundaries.md) when handling credentials, computer-hosted services or Trigger access.
