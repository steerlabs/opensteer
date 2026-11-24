/** A record of Remote access taken away, as the Home writes it (`security_audit`). */
export interface RemoteAccessNarrowingRecord {
  readonly action: "remote-access.connect-off" | "remote-access.connect-removed";
  /** Who acted: the person, through a change they asked for, or the Mac app cleaning up. */
  readonly metadata: { readonly by?: "person" | "app-cleanup" };
}

/**
 * What Activity says about it, true about who did it: the Mac app's own startup cleanup is
 * Opensteer on that Mac acting, never the person choosing to turn Remote access off.
 */
export function remoteAccessActivitySentence(
  record: RemoteAccessNarrowingRecord,
  mac: string,
): string {
  const off = record.action === "remote-access.connect-off";
  if (record.metadata.by === "person")
    return off ? `You turned Remote access off on ${mac}` : `You removed Remote access from ${mac}`;
  return off
    ? `Opensteer on ${mac} turned Remote access off while cleaning up`
    : `Opensteer on ${mac} removed Remote access while cleaning up`;
}
