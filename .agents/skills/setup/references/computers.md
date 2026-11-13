# Set up a computer

Open the desktop app on that Mac and sign in: it shows **Set up this Mac** and becomes one of the
person's devices. A headless computer is added from Settings → Devices → **Add a device** → Server.
Let the owner-session Host choose the grant and target. Use from anywhere (Settings → Account) must
be on before a remote computer connects, and tasks execute only on the hosting computer; other
devices are tool targets. Change what a device offers with its switches on its Devices page; never
remove and re-add it for that: removal signs it out and deletes its identity and SSH host key.

**App access.** The computer's owner can approve new or broader app access from any signed-in
device. Missing macOS permissions still require local action on the target Mac
([set up a Mac app](../../mac-gui/references/app-setup.md)); app approval does not grant them.
Checking status must not open prompts. For Full Disk Access, use the Open System Settings action
and have the person grant it to the app that launches the Runner.

**Agent SSH.** Use the shipped
[opensteer:computers skill](../../../../apps/runner/agent-skills/skills/computers/SKILL.md), the
current Run inventory and generated host-key pins; never disable host-key checks. SFTP shares,
command authority and target-network forwarding are separate. Report policy refusals instead of
bypassing them. Keep local SSH alive while remote work runs, and verify remote jobs stopped before
releasing the session: ending it terminates the tracked process group, and escaped groups have no
termination guarantee.
