---
name: plugins
description: Find and call plugin tools, combine calls in JavaScript, install catalog plugins, or write and deploy sandboxed TypeScript plugins.
---

# Opensteer Plugins

Use `plugin_search` to find exact paths and input types. Call one or a few independent tools with `plugin_call`; use `plugin_describe` for full signatures. When results feed other calls, or a large result needs filtering, read [Code mode](references/code-mode.md) and use `plugin_execute`.

`opensteer_plugin_list` shows installed versions, account links and status. A full-access Run can install without approval, export source, activate an earlier version or remove a plugin. To install a catalog entry, call `opensteer_plugin_install` with `source:"catalog"` and `catalogId`. URLs use `source:"mcp"`, `"openapi"` or `"graphql"`, plus `url` and `name`.

Accounts and input belong to the person in Needs you. Pending means wait, without polling or repeating the operation. After the person answers, use `plugin_resume` with the executionId; never rerun the source to continue it. Earlier effects survive errors and cancellation. See [Accounts and approvals](references/accounts-and-approvals.md).

To create or change a plugin, read [Writing a plugin](references/writing-a-plugin.md). A folder in Agent home is a draft; the deployed version is the truth. Device data apps and local servers use the same tool namespace when available. Mac GUI and Android phone interaction use `computer_use` instead.
