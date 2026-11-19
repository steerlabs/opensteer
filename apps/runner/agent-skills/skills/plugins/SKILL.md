---
name: plugins
description: Find and call plugin tools, combine calls in JavaScript, install catalog plugins, or write and deploy sandboxed TypeScript plugins.
---

# Opensteer Plugins

Use `plugin_search` to find exact paths and input types. Search by the task ("send email"), not only the service's name, and read a plugin's own instructions with `plugin_skills` before first use. Call one or a few independent tools with `plugin_call`; use `plugin_describe` for full signatures. When results feed other calls, or a large result needs filtering, read [Code mode](references/code-mode.md) and use `plugin_execute`.

`opensteer_plugin_list` pages installed plugins (follow `cursor`) with newest versions, account links and status, and under `local` device data apps and local servers with tool counts; a server awaiting approval appears only there. Pass `pluginId` for every kept version of one plugin. A full-access Run can install without approval, export source, activate an earlier version or remove a plugin. Find a catalog entry by service or purpose with `opensteer_plugin_catalog` (page with its cursor); install it with `opensteer_plugin_install`, `source:"catalog"` and its `catalogId`. URLs use `source:"mcp"`, `"openapi"` or `"graphql"`, plus `url` and `name`.

Accounts and input belong to the person in Needs you. Follow the result's `next`. Blocked namespaces and individual tools carry `code`, `message` and `next`; readable tools remain usable when a write needs more access. Follow the blocked tool's next step before calling it. A task ceiling cannot be raised by another grant, and an offline device needs its owner rather than another access request. After the person answers, use `plugin_resume` with the executionId; never rerun the source to continue it. Earlier effects survive errors and cancellation. See [Accounts and approvals](references/accounts-and-approvals.md).

To create or change a plugin, read [Writing a plugin](references/writing-a-plugin.md). A folder in Agent home is a draft; the deployed version is the truth. Device data apps and local servers use the same tool namespace. Mac apps and phone screens (Android Agent Phones and Mac-driven iPhones) use `computer_use` instead.

To make an app, command-line tool or network device on the person's computer a plugin, prefer: Opensteer's device data apps for protected data; the app's own interface (official CLI, a server it ships, AppleScript or Shortcuts, a local API, its files) as a local server (opensteer:devices); a reverse-engineered one only when the person asks and accepts its maker may block them; `computer_use` last. Registering a changed local server asks the person again.

Device data apps are Calendar, Contacts, Reminders and Messages on a Mac, and Calendar, Contacts, Reminders, Photos and Location on an iPhone. To get one that is not listed yet, or read-write on one, call `app_access_request` with `dataApp`, the `computerId` it is on when known, `access` and a one-sentence `reason`; when a local server's tools say access is needed, call it with `server` instead. The person answers in Needs you. Read [Apple Messages](references/apple-messages.md) before querying, exporting or sending in Messages.

Use `plugin_resources` to read schedules and runs, live-first workflow history (follow every cursor), and webhook subscriptions. `opensteer_plugin_resource_update` configures or runs schedules, starts or stops workflows, and removes webhooks. Use one stable key per intended workflow start so an interrupted start can be recovered without duplicating it. Runs remain readable and stoppable when the current plugin no longer declares them.

Use `plugin_skills` for account-dependent live skills: `{}` lists, `{app}` lists one namespace, `{app,name}` reads a skill and `{app,name,file}` reads a reference. Packaged text skills also arrive natively from the active version without starting the engine.

The person alone links accounts and enters credentials, answers scheduled approvals, finishes manual webhook setup (which can reveal a signing secret), and confirms provider-side webhook cleanup. Agents can request account consent through `plugin_account_request` and explain which Plugins control needs attention. These decisions attest consent or external setup; an agent must not attest them for the person.
