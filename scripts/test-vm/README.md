# GUI test VMs

[Testing](../../docs/testing.md#gui-test-vms) defines which checks need a VM.
Use the [GUI journey skill](../../.agents/skills/run-gui-journeys/SKILL.md) for
invocation, cache recovery and diagnostics. [test-vm.ts](../test-vm.ts) and
its modules own arguments, payloads and guest lifecycle.

## Ownership and capacity

The host screen belongs to the founder. Jobs boot private clones of stopped
goldens; never boot a golden or run these journeys on a personal desktop.
Apple silicon macOS and Tart are required. Apple's licence limits this setup to
two concurrent macOS guests, including guests started by other managers.
Slot/admission locks cover clone through teardown; never replace or delete lock
files while runners live, or change lock locations before stopping old runners.

Admission needs 40 GiB free and running work stops below 30 GiB to preserve
export/teardown space. Logical VM disk growth does not create host free space.
Golden bootstrap also needs space for licensed inputs, installed tools and clone
writes. Cached jobs still pay boot/staging/export costs; group related cases.
See [test-vm.ts](../test-vm.ts) and [storage-retention.ts](../storage-retention.ts).

Shares for source and resources are read-only; only a job's artifacts are writable.
Graphics, audio and clipboard sharing stay disabled. SIGKILL/power loss cannot
run cleanup: use the job record to identify only that job's clone. Unknown residue
is never permission to stop another runner or delete an unowned VM.

## Payloads and retention

Native seeds must be validated release resources, not an installed app. Services
and web are rebuilt from the requested SHA. Replace the seed and invalidate the
affected SHA cache after native runtime inputs change. See
[test-vm.ts](../test-vm.ts) and `OPENSTEER_VM_NATIVE_RESOURCES` in
[test-vm.ts](../test-vm.ts).

Retention cannot overlap payload builds or prune live/locked/referenced jobs.
Unknown identity, ownership or age keeps a candidate. It preserves goldens, crash
symbols and installed Beta artifacts; it never changes the installed application.
The low-space warning never broadens deletion authority. APFS sharing means
allocated bytes removed need not equal observed space freed. Read retention
receipts before manual cleanup; policy lives in
[storage-retention.ts](../storage-retention.ts).

## Recreating the golden

Golden provisioning refuses an existing destination. The local disposable base
retains default `admin/admin` credentials, disabled SIP and SSH TCC grants.
Never publish the VM, key or a remote login endpoint. A single SSH key opens
all goldens: preserve its matching pair across retries. Cold-boot permission and
actual input/capture proof are required; configuration alone is insufficient.
See [provision-guest.sh](provision-guest.sh).

## Mobile simulator golden

Provisioning uses trusted licensed Xcode/runtime archives outside the checkout.
An exported runtime is the complete `.exportedBundle`, including restore metadata;
its inner cryptex DMG is insufficient. Export may also install/register the runtime
on the downloading Mac. A globally listed simulator type does not prove it is
supported by the pinned runtime. Only a cold boot with actual simulator proof
certifies the golden; simulator proof does not qualify the app. Tool versions,
manifest validation and host bootstrap live in [test-vm.ts](../test-vm.ts);
[provision-mobile.sh](provision-mobile.sh) runs inside the guest. Bootstrap with
`pnpm test:vm -- --mobile-golden --tooling-inputs /absolute/inputs`; preparing
those inputs is the [mobile golden skill](../../.agents/skills/prepare-mobile-golden/SKILL.md).
Mobile app procedures belong to [mobile guidance](../../docs/mobile.md).

## Persistent guest journey protocol

Follow [the persistent-guest safety contract](../../docs/testing.md#persistent-guest-journey-protocol)
and use the [GUI journey skill](../../.agents/skills/run-gui-journeys/SKILL.md).
The runner source owns manifest fields and exit codes.
