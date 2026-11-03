# SSH commands and sessions

Every computer you can reach is an ordinary SSH host. Use `ssh`, `scp`, `sftp`, `rsync`, and `git` the way you already do. There are no Opensteer tools for this, no custom CLI, and nothing to install or configure.

```bash
ssh example-mac gh pr list
scp example-mac:Pictures/x.heic .
rsync -a example-mac:Projects/app/ ./app/
git clone example-mac:Projects/app
ssh -N -L 8080:localhost:8080 example-mac
```

Remote paths are absolute or relative to that computer's home, and `~` or `~/x` mean that computer's home too. `~user` paths are refused. Quote paths with spaces once for your shell and once for the remote one.

## No interactive terminal

Run non-interactive commands. A bare `ssh example-mac`, `ssh -t`, and anything that wants a terminal — a pager, an editor, a program that prompts — are refused with `Opensteer does not provide interactive terminals; run a command.` and exit status 126. Pass the whole job as a command instead, and use `-N` when you only want a port forward and no command at all.

## What runs, and as whom

Commands run as that computer's Opensteer account, from that account's home directory, with its files, its logins, and its network — its `gh`, its `docker`, its VPN. That account and machine are not this Run's Workspace: nothing crosses between them unless you copy it.

Shared folders bound file transfer over sftp and scp, not commands. Where commands are allowed a command reaches whatever that account reaches; where they are off, the shares are all there is. `scp -O` is the exception on the transfer side: it uses the legacy protocol, which runs a remote command, so it needs commands allowed and is not bounded by the shares. Plain `scp` and `sftp` are.

A session lives exactly as long as the local `ssh` process, and every session ends when this Run ends. The remote command is tied to that process: when the local `ssh` exits or is killed, Opensteer terminates the remote command's process group. `nohup` and a trailing `&` do not keep work alive. Processes that escape their tracked process group — `setsid` and anything else that starts a new one — are outside the termination guarantee, so nothing here proves they stopped. Keep the SSH process alive while its command must run and observe its terminal result.

Activity is bytes in either direction, a channel opening, or a request on the session — not output alone. A session with no activity at all for 30 minutes is terminated mid-run, taking a silent command with it. For long silent work, make it print something periodically, or split it into steps.

Nothing resumes. If a session ends mid-transfer, run the transfer again — `rsync` picks up where it stopped, `scp` starts over.

- On Codex, machine access is only set up in Full access mode, on every kind of Runner. In every other mode no computers are listed, and there is nothing to retry or escalate — say that a new Run in Full access can reach them.
- When the note lists no computers, it says why in one sentence. Relay that sentence; do not tell the person to enable sharing or commands on their computer, which the note would have listed if the cause were there.
- On Linux cloud Runners, this Run's sandbox may connect to any local Unix socket while machine access is set up.
- An alias comes from the computer's name. Renaming it changes the alias for later Runs only — the aliases in this Run's note keep working for this whole Run.
- The list is a snapshot from when the Run started. A computer listed as offline may be up now, so it is worth trying; a newly enrolled or newly shared computer appears in the next Run's note, not this one's.
