# Computer access and refusals

The note says per Mac whether macOS Full Disk Access is on for the process running that computer's Opensteer Runner. It lets separately authorized commands reach protected files; it does not authorize commands, integrations, or computer access by itself.

Where it is off, some protected data may fail with `Operation not permitted`; another macOS permission may still allow a particular location. Nothing you retry changes a missing permission — not `sudo`, not a different path to the same file, not copying it somewhere else first. The command may be right while macOS still refuses the Runner process.

If `machine_full_disk_access_request` is listed for this Run, request it with the exact computer alias from the note and one sentence about what you need to open. Otherwise return the exact Mac alias and access needed to your assigner. Wait for the permission result before using the protected files. The person completes the macOS permission setup at that Mac for the process running its Opensteer Runner, and Opensteer tells you when it is on — or that they declined. If they decline, carry on without those folders and do not ask again unless they bring it up.

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

- Never pass `-o StrictHostKeyChecking=no`, `-o UserKnownHostsFile=/dev/null`, or an `-F` of your own, and never edit the generated ssh config or `known_hosts`. Opensteer writes them for exactly the computers this Run's note lists, and they pin each computer's host key. A host key failure is a real problem to report, not one to configure away.

The latest Opensteer note about other computers is the inventory. The note names each computer you can reach, its platform and whether it is online, the folders it shares with `read-only` or `read-write`, whether commands are allowed there, whether port forwarding is allowed there, and on a Mac whether macOS Full Disk Access is on. When it says no other computers are reachable from this Run, nothing here applies, whatever an earlier note in this conversation listed. A line saying some computers are not listed means exactly that: those computers cannot be addressed from this Run at all, and there is no way to ask for them here.
