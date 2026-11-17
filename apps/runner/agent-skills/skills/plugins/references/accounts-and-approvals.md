# Accounts and approvals

Never ask for service secrets in chat, put them in tool arguments/source, or search files for tokens. Call plugin_account_request with pluginId, requirement, scope and the task's reason. The person chooses a new account or an existing saved account in Needs you. Reusing the same provider's saved account for another plugin still needs their consent. Installing a plugin needs no approval; linking an account always does. Agents cannot create, link, unlink or change agent access.

The account card names the plugin and its author, the declared credential destinations and whether code receives a real value or a sealed handle. Linking trusts plugin code: setup runs with the account before tool approval. A changed declaration requires a fresh consent snapshot. Decline means continue without it; don't ask again unless the person asks.

The owner can set each plugin to all, read-only or off. Read-only exposes tools labeled queries; an unlabeled tool counts as a write. The label is the plugin author's claim, not a guarantee about external effects.

Auto and full-access Runs accept tool approval rules automatically. Approval-required and auto-accept-edits Runs ask when a tool declares an approval rule; a write with no rule can run without asking. Tool input always goes to the person. Never fill a plugin.input form or approve a plugin.approval Request yourself.

A foreground call may stay held until the person answers, then return the tool's real result. Voice, background and Trigger/Watch programs get pending immediately. If a hold ends first, keep its executionId: the answer wakes the task and a later Run calls plugin_resume. Don't poll, repeat the call, or rerun a program. A different task/program cannot resume that id. Stop discards the execution; expiry or engine restart interrupts its wait. Earlier calls may have taken effect; inspect state before new work.
