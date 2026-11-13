---
name: computers
description: Use Opensteer SSH access for another computer’s files, commands or forwarded ports. List, rename or revoke computers and stop access sessions.
---

# Opensteer Computers

Use the latest other-computers note as this Run's inventory. It names reachable aliases, platforms, online state, shared folders, command and forwarding permissions, and Mac Full Disk Access. Ordinary `ssh`, `scp`, `sftp`, `rsync` and `git` use those aliases; no extra CLI or setup is needed. A computer omitted from this Run cannot be addressed here. Relay the note's reason rather than inventing setup advice.

`computer_list` lists owned devices, online state, Browser/Apps/Files switches and active sessions, including devices with access off. This does not grant SSH access. `computer_write` renames/revokes a computer or stops an access session
with full-access and personal access. Do those actions directly when authorized. Enrollment,
pairing and new grants need the person.

Use opensteer:computer-use to see or operate Mac app interfaces and Agent Phones. An Agent Phone is not an SSH host and is absent from the SSH note. A USB phone attached to a computer is that computer's device, reached with `adb` in its authorized shell.

Work within the remote account's authority. Shared folders constrain SFTP and default SCP, not authorized commands. Preserve the generated SSH config and host-key pins; report host-key failures and refused authority rather than bypassing them. Keep the SSH process alive while remote work must run and verify its terminal outcome.

- Read [SSH](references/ssh.md) before running commands, copying files or forwarding ports, especially for session lifetime and path semantics.
- Read [access](references/access.md) when the inventory omits a computer, macOS denies protected files or a connection is refused.
