---
name: plugins
description: Find and call plugin tools, combine calls in JavaScript, install catalog plugins, or write and deploy sandboxed TypeScript plugins.
---

# Opensteer Plugins

Use `plugin_search` to find exact paths and input types. Call one or a few independent tools with `plugin_call`; use `plugin_describe` for full signatures. When results feed other calls, or a large result needs filtering, read [Code mode](references/code-mode.md) and use `plugin_execute`.

`opensteer_plugin_list` shows installed versions, account links and status, and under `local` the device data apps and local servers in the same namespace. A full-access Run can install without approval, export source, activate an earlier version or remove a plugin. Find a catalog entry by service or purpose with `opensteer_plugin_catalog`; page using its cursor and take the returned id. To install it, call `opensteer_plugin_install` with `source:"catalog"` and `catalogId`. URLs use `source:"mcp"`, `"openapi"` or `"graphql"`, plus `url` and `name`.

Accounts and input belong to the person in Needs you. Pending means wait, without polling or repeating the operation. After the person answers, use `plugin_resume` with the executionId; never rerun the source to continue it. Earlier effects survive errors and cancellation. See [Accounts and approvals](references/accounts-and-approvals.md).

To create or change a plugin, read [Writing a plugin](references/writing-a-plugin.md). A folder in Agent home is a draft; the deployed version is the truth. Device data apps and local servers use the same tool namespace when available. Mac GUI and Android phone interaction use `computer_use` instead.

Device data apps are Calendar, Contacts, Reminders and Messages on a Mac, and Calendar, Contacts, Reminders, Photos and Location on an iPhone. To get one that is not listed yet, or read-write on one, call `app_access_request` with `dataApp`, the `computerId` it is on when known, `access` and a one-sentence `reason`; when a local server's tools say access is needed, call it with `server` instead. The person answers in Needs you. Read [Apple Messages](references/apple-messages.md) before querying, exporting or sending in Messages.

Use `plugin_resources` to read schedules and runs, live-first workflow history (follow every cursor), and webhook subscriptions. `opensteer_plugin_resource_update` configures or runs schedules, starts or stops workflows, and removes webhooks. Use one stable key per intended workflow start so an interrupted start can be recovered without duplicating it. Runs remain readable and stoppable when the current plugin no longer declares them.

Use `plugin_skills` for account-dependent live skills: `{}` lists, `{app}` lists one namespace, `{app,name}` reads a skill and `{app,name,file}` reads a reference. Packaged text skills also arrive natively from the active version without starting the engine.

The person alone links accounts and enters credentials, answers scheduled approvals, finishes manual webhook setup (which can reveal a signing secret), and confirms provider-side webhook cleanup. Agents can request account consent through `plugin_account_request` and explain which Plugins control needs attention. These decisions attest consent or external setup; an agent must not attest them for the person.
