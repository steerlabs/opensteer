import { useState, type FormEvent } from "react";
import type { ChannelProviderManifest } from "@opensteer/channel-core";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import type { MachineSummary } from "@opensteer/protocol";
import { act, failureWords } from "./use-action.js";

type Created = Extract<
  Awaited<ReturnType<HostClient["dispatch"]>>,
  { readonly type: "channel.connection.computer.create" }
>;

/**
 * Setting up a channel whose transport runs on one of your own computers —
 * iMessage through a Mac signed into an Apple account kept for the bot. There
 * is nothing to paste: the Mac is the credential, its Messages app connection
 * the permission. Who "me" is comes after, by a code sent from your own account.
 */
export function ComputerChannelSetup({
  hostClient,
  machines,
  onCancel,
  onCreated,
  provider,
}: {
  readonly hostClient: Pick<HostClient, "dispatch">;
  readonly machines: readonly MachineSummary[];
  readonly onCancel: () => void;
  readonly onCreated: (created: Created) => void;
  readonly provider: ChannelProviderManifest;
}) {
  const eligible = machines.filter(
    (machine) =>
      machine.status === "online" &&
      machine.modules.messaging !== undefined &&
      (machine.apps ?? []).some(({ definitionId }) => definitionId === provider.computerApp),
  );
  const [runnerId, setRunnerId] = useState(eligible[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runnerId) return;
    setPending(true);
    setError(null);
    try {
      const result = await act(
        null,
        { label: "set up this channel", done: "set up", happened: "this channel was set up" },
        () =>
          hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey("channel-computer-connection"),
            provider: provider.provider,
            runnerId,
            type: "channel.connection.computer.create",
          }),
      );
      if (result.type !== "channel.connection.computer.create") {
        setError("The channel could not be set up.");
        return;
      }
      onCreated(result);
    } catch (reason) {
      setError(failureWords(reason) ?? "The channel could not be set up.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="section" onSubmit={(event) => void submit(event)}>
      <p className="section__hint">
        Sign a Mac into Messages with an Apple account kept for the bot, and turn on Messages for it
        on its Devices page with reading and sending. Once it is connected, link your own iMessage
        account with a code, then add a chat.
      </p>
      {eligible.length === 0 ? (
        <p className="notice" role="status">
          No online Mac of yours has Messages turned on yet. Turn it on from that Mac&apos;s Devices
          page first.
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
        <button className="btn btn--primary" disabled={pending || !runnerId} type="submit">
          {pending ? "Checking…" : `Connect ${provider.label}`}
        </button>
      </div>
    </form>
  );
}
