# Set up a computer

In the desktop app, open Settings → Devices → Computers → **Add a computer**. Let the owner-session
Host choose the grant and target. Personal remote access (Settings → Account → Remote access) must
be on before a remote computer connects, and tasks execute only on the hosting computer; other enrolled computers are tool targets.
Never remove and re-add a computer to change what it may run or reach: removal deletes its identity
and SSH host key. Configure Files and commands separately from Apps.

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
