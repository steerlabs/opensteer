---
name: computers
description: Use Opensteer SSH access for another computer’s files, commands or forwarded ports. List, rename or remove computers and end access sessions.
---

# Opensteer Computers

Use the latest other-computers note as this Run's inventory. It names reachable aliases, platforms, online state, shared folders, command and forwarding permissions, and Mac Full Disk Access. Ordinary `ssh`, `scp`, `sftp`, `rsync` and `git` use those aliases; no extra CLI or setup is needed. A computer omitted from this Run cannot be addressed here. Relay the note's reason rather than inventing setup advice.

`computer_list` lists the person's computers and phones with their `computerId`, online state, browser, apps and files switches and active sessions, including those with access off. This does not grant SSH access. `opensteer_command` renames a computer (`machine.rename`), removes one (`machine.revoke`) or ends an access session (`machine.access.session.stop`). Do those actions directly when authorized. Enrollment,
pairing and new grants need the person.

Use opensteer:computer-use to see or operate Mac app interfaces and phone screens (Android Agent Phones and Mac-driven iPhones). A phone is not an SSH host and is absent from the SSH note. A Mac-driven iPhone is its own device: reach it only through computer_use, never through its Mac's shell; removing it leaves its Mac, and removing the Mac leaves the iPhone listed as not connected. Another USB Android phone attached to a computer is that computer's device, reached with `adb` in its authorized shell.

Work within the remote account's authority. Shared folders constrain SFTP and default SCP, not authorized commands. Preserve the generated SSH config and host-key pins; report host-key failures and refused authority rather than bypassing them. Keep the SSH process alive while remote work must run and verify its terminal outcome.

- Read [SSH](references/ssh.md) before running commands, copying files or forwarding ports, especially for session lifetime and path semantics.
- Read [access](references/access.md) when the inventory omits a computer, macOS denies protected files or a connection is refused.
