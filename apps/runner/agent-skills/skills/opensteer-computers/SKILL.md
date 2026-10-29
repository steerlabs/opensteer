---
name: opensteer-computers
description: For another computer's files, commands, repositories or ports, use SSH. To see or operate apps on a person's Mac, use the computer tool (opensteer-computer-use). For Android phones, use the computer tool; they never use SSH.
---

# Opensteer Computers

Use this skill for another computer's files and shell; to see or operate apps on a person's Mac, use the computer tool (opensteer-computer-use). An Android phone added to Opensteer is not an SSH host and never appears in the inventory: agents use it whole through the computer tool. A phone plugged into a computer over USB is that computer's device, reached with `adb` in that computer's shell like any other tool there.

Every computer you can reach is an ordinary SSH host. Use `ssh`, `scp`, `sftp`, `rsync`, and `git` the way you already do. There are no Opensteer tools for this, no custom CLI, and nothing to install or configure.

The most recent Opensteer note about other computers is the inventory. It names each computer you can reach, its platform and whether it is online, the folders it shares with `read-only` or `read-write`, whether commands are allowed there, whether port forwarding is allowed there, and on a Mac whether macOS Full Disk Access is on. When it says no other computers are reachable from this Run, nothing here applies, whatever an earlier note in this conversation listed. A line saying some computers are not listed means exactly that: those computers cannot be addressed from this Run at all, and there is no way to ask for them here.

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

## macOS Full Disk Access

The note says per Mac whether macOS Full Disk Access is on for the process running that computer's Opensteer Runner. It lets separately authorized commands reach protected files; it does not authorize commands, integrations, or computer access by itself.

Where it is off, some protected data may fail with `Operation not permitted`; another macOS permission may still allow a particular location. Nothing you retry changes a missing permission — not `sudo`, not a different path to the same file, not copying it somewhere else first. The command may be right while macOS still refuses the Runner process.

Ask for it with `machine_full_disk_access_request`, naming the computer with the alias from the note and giving one sentence about what you need to open. Then wait. The person completes the macOS permission setup at that Mac for the process running its Opensteer Runner, and Opensteer tells you when it is on — or that they declined. If they decline, carry on without those folders and do not ask again unless they bring it up.

Once Opensteer reports that it is on, run the same command again in a new session.

## Refusals are settings, not mistakes

A refusal means the computer's owner set their access settings that way. Do not rewrite the command, hunt for another route, or retry — report what was refused and carry on with the rest of the work. In these sentences `example-mac` is the computer's name as shown in Opensteer, which is not always the alias you typed. Other refusals exist — a malformed request, an oversized audit record — and they say what they are; the common refusals are:

- `example-mac does not allow commands from other computers.` — commands are off. sftp and scp still work inside the shares; `rsync` and `git` do not, because both run a command on the far side.
- `Opensteer does not provide interactive terminals; run a command.`
- `Commands longer than 4096 bytes are refused.` — pass the work as a script you copy over, or a shorter command.
- `example-mac does not allow port forwarding from other computers.` — `-L` is off.
- `Not shared. example-mac shares: /Users/person/Pictures (read-only), /Users/person/Projects (read-write).` — the path is outside every share. The sentence lists what is shared; work from those paths. With nothing shared it reads `Not shared. example-mac shares no folders.`
- `Shared folder /Users/person/Pictures is read-only.` — the path is inside a share that does not allow writing.
- `Only shared folders can be changed. example-mac shares: /Users/person/Pictures (read-only), /Users/person/Projects (read-write).` — the write was to the home directory or to a folder above a share rather than inside one.
- `SFTP ~user paths are not supported.` — name the path absolutely, or relative to that computer's home.

A connection that is refused before SSH starts — the computer is offline, does not allow access from other computers, or already has too many connections — prints its own complete sentence and exits 255.

## Sessions, and commands that take a while

A session lives exactly as long as the local `ssh` process, and every session ends when this Run ends. The remote command is tied to that process: when the local `ssh` exits or is killed, Opensteer terminates the remote command's process group. `nohup` and a trailing `&` do not keep work alive. Processes that escape their tracked process group — `setsid` and anything else that starts a new one — are outside the termination guarantee, so nothing here proves they stopped. Keep the local process alive for as long as the remote work needs — use the Bash tool's own background execution and generous timeouts, then poll for the result.

Activity is bytes in either direction, a channel opening, or a request on the session — not output alone. A session with no activity at all for 30 minutes is terminated mid-run, taking a silent command with it. For long silent work, make it print something periodically, or split it into steps.

Nothing resumes. If a session ends mid-transfer, run the transfer again — `rsync` picks up where it stopped, `scp` starts over.

## Details worth knowing

- Never pass `-o StrictHostKeyChecking=no`, `-o UserKnownHostsFile=/dev/null`, or an `-F` of your own, and never edit the generated ssh config or `known_hosts`. Opensteer writes them for exactly the computers this Run's note lists, and they pin each computer's host key. A host key failure is a real problem to report, not one to configure away.
- On Codex, machine access is only set up in Full access mode, on every kind of Runner. In every other mode no computers are listed, and there is nothing to retry or escalate — say that a new Run in Full access can reach them.
- When the note lists no computers, it says why in one sentence. Relay that sentence; do not tell the person to enable sharing or commands on their computer, which the note would have listed if the cause were there.
- On Linux cloud Runners, this Run's sandbox may connect to any local Unix socket while machine access is set up.
- An alias comes from the computer's name. Renaming it changes the alias for later Runs only — the aliases in this Run's note keep working for this whole Run.
- The list is a snapshot from when the Run started. A computer listed as offline may be up now, so it is worth trying; a newly enrolled or newly shared computer appears in the next Run's note, not this one's.
