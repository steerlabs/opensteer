import { useState, type FormEvent } from "react";
import type { ChannelProviderManifest } from "@opensteer/channel-core";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import type { MachineSummary } from "@opensteer/protocol";

type Created = Extract<
  Awaited<ReturnType<HostClient["dispatch"]>>,
  { readonly type: "channel.connection.computer.create" }
>;

/**
 * Setting up a channel whose transport runs on one of your own computers —
 * iMessage through a Mac signed into an Apple account kept for the bot. There
 * is nothing to paste: the Mac is the credential, its Messages app connection
 * the permission, and your own handles are how the bot knows it is you.
 */
export function ComputerChannelSetup({
  hostClient,
  machines,
  onCancel,
  onCreated,
  provider,
  workspaces,
  defaultWorkspaceId,
}: {
  readonly defaultWorkspaceId: string;
  readonly hostClient: Pick<HostClient, "dispatch">;
  readonly machines: readonly MachineSummary[];
  readonly onCancel: () => void;
  readonly onCreated: (created: Created) => void;
  readonly provider: ChannelProviderManifest;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}) {
  const eligible = machines.filter(
    (machine) =>
      machine.status === "online" &&
      machine.modules.messaging !== undefined &&
      (machine.apps ?? []).some(({ definitionId }) => definitionId === provider.computerApp),
  );
  const [runnerId, setRunnerId] = useState(eligible[0]?.id ?? "");
  const [handles, setHandles] = useState("");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerHandles = handles
    .split(/[\n,]/u)
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runnerId || ownerHandles.length === 0 || !workspaceId) return;
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey("channel-computer-connection"),
        ownerHandles,
        provider: provider.provider,
        runnerId,
        type: "channel.connection.computer.create",
        workspaceId,
      });
      if (result.type !== "channel.connection.computer.create") {
        throw new Error("Channel command mismatch.");
      }
      onCreated(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The channel could not be set up.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section" onSubmit={(event) => void submit(event)}>
      <p className="section__hint">
        Sign a Mac into Messages with an Apple account kept for the bot, turn on Messages for it on
        its Computers page with reading and sending, then text that account from your phone. Texts
        from anyone else wait for your approval here and get no reply.
      </p>
      {eligible.length === 0 ? (
        <p className="notice" role="status">
          No online Mac of yours has Messages turned on yet. Turn it on from that Mac&apos;s
          Computers page first.
        </p>
      ) : (
        <>
          <label className="field">
            <span className="field__label">Mac</span>
            <select onChange={(event) => setRunnerId(event.currentTarget.value)} value={runnerId}>
              {eligible.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">You text from</span>
            <textarea
              onChange={(event) => setHandles(event.currentTarget.value)}
              placeholder={"+1 555 123 4567\nyou@example.com"}
              rows={2}
              value={handles}
            />
            <span className="field__hint">
              Your phone number with its country code, or your Apple account email. One per line.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Workspace</span>
            <select
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
              value={workspaceId}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="form-actions">
        {error ? (
          <span aria-live="assertive" className="form-actions__error" role="alert">
            {error}
          </span>
        ) : null}
        <button className="btn" disabled={pending} onClick={onCancel} type="button">
          Back
        </button>
        <button
          className="btn btn--primary"
          disabled={pending || !runnerId || ownerHandles.length === 0 || !workspaceId}
          type="submit"
        >
          {pending ? "Checking…" : `Connect ${provider.label}`}
        </button>
      </div>
    </form>
  );
}
