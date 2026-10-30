---
name: setup-computer
description: Enroll a computer or resolve its SSH and app access setup when lending a machine to an Opensteer Deployment.
---

# Set up computer access

Read [Computers](../../../docs/computers.md). In the desktop app, open Settings → Computers
and add the named local computer. Let the owner-session Host choose the grant/target.
Personal remote access must be on before a remote computer connects; Personal computers
other than Main cannot execute agents. Do not remove/readd to change execution or reach:
removal deletes identity and SSH host key. Configure Files and commands separately from Apps.

For app access, finish new/broader approval on the data-holding Mac. A remote client can
request setup but cannot prove locality. Complete any missing macOS grant on that Mac;
reapproving access does not grant OS permission. Inspecting status must not open prompts.
For Full Disk Access, use the explicit Open System Settings action and have the person grant
it to the Runner's launching app. Do not confuse it with engine Full access or helper grants.

For agent SSH commands and diagnosis, use the shipped
[opensteer-computers skill](../../../apps/runner/agent-skills/skills/opensteer-computers/SKILL.md).
Use the current Run inventory and generated host-key pins; never disable host-key checks.
Distinguish SFTP shares from command authority and target-network forwarding. Report policy
refusals instead of bypassing them. Keep local SSH alive while remote work runs; ending the
session terminates its tracked process group.

Stop each diagnostic tunnel/server/capture loop you started with `kill <recorded-pid>`,
including after failures. Verify remote jobs stopped before releasing a session; escaped
process groups have no termination guarantee. Leave existing user-owned services running.
Emulators and USB phones require one owner; if used, stop only emulators you started with
`adb -s <serial> emu kill` and an ADB server you started with `adb kill-server`.
