import type { LocalWorkspaceBindingRef } from "@opensteer/protocol";
import type { LocalWorkspaceAuthority, NativeFsHelper } from "@opensteer/workspace-local";

export async function resolveAppWorkspaceRoot(
  authority: Pick<LocalWorkspaceAuthority, "resolveReadAuthority">,
  filesystem: Pick<NativeFsHelper, "directoryIdentity">,
  binding: LocalWorkspaceBindingRef,
  signal: AbortSignal,
): Promise<string> {
  const read = await authority.resolveReadAuthority(binding, signal);
  const identity = await filesystem.directoryIdentity({ root: read.root, path: "." }, signal);
  if (
    identity.kind !== read.rootIdentity.kind ||
    identity.volumeId !== read.rootIdentity.volumeId ||
    identity.fileId !== read.rootIdentity.fileId
  )
    throw new Error("The Workspace root was replaced");
  return read.root;
}
