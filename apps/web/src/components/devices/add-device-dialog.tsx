import { DeploymentIdSchema } from "@opensteer/core";
import { useId, useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import {
  computerConnectionCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { act, failureWords } from "../use-action.js";
import { useShell } from "../app-shell.js";
import { AddPhoneDialog } from "../computers/add-phone-dialog.js";
import { Dialog } from "../dialog.js";
import { phoneOpenUrl } from "../first-run/phone-setup.js";
import { QrCode } from "../first-run/qr-code.js";
import { Icon, type IconName } from "../icon.js";
import { OptionRow } from "../option-row.js";
import { SettingsError } from "../settings/primitives.js";
import { AddIphoneDialog } from "./add-iphone-dialog.js";
import { AddChrome } from "../chrome/add-chrome.js";
import { cancelDeviceSetup } from "./device-access.js";
import { IphoneSetupOnMac } from "./iphone-setup-needs.js";
import { localEnrollmentModules } from "./this-device.js";

type Choice = "mac" | "phone" | "chrome" | "iphone-screen" | "agent-phone" | "server" | "pairing";

/**
 * Adding a device is organised by the thing being added. Each Mac or phone signs in with the
 * same Opensteer account; a pairing code, for a device that won't sign in, is under Advanced.
 */
const choices: readonly {
  readonly id: Exclude<Choice, "pairing">;
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    id: "mac",
    icon: "laptop",
    title: "A Mac",
    detail: "Install Opensteer on it and sign in with the same account.",
  },
  {
    id: "phone",
    icon: "phone",
    title: "A phone",
    detail: "Get the Opensteer app and sign in, or scan this code.",
  },
  {
    id: "chrome",
    icon: "globe",
    title: "Chrome",
    detail: "Share tabs from your Chrome.",
  },
  {
    id: "iphone-screen",
    icon: "phone",
    title: "iPhone screen control",
    detail: "An iPhone your agent controls through your Mac, plugged in or on the same Wi‑Fi.",
  },
  {
    id: "agent-phone",
    icon: "phone",
    title: "Android Agent Phone",
    detail: "An Android phone you give to your agent, set up over USB.",
  },
  {
    id: "server",
    icon: "server",
    title: "Linux server",
    detail: "A computer without a screen, connected with one command.",
  },
];

const choiceTitles: Readonly<Record<Choice, string>> = {
  mac: "Add a Mac",
  phone: "Add a phone",
  chrome: "Add Chrome",
  "iphone-screen": "Control an iPhone’s screen",
  "agent-phone": "Add an Android Agent Phone",
  server: "Add a Linux server",
  pairing: "Use a pairing code",
};

export function AddDeviceDialog({
  homeName,
  onClose,
}: {
  readonly homeName: string;
  readonly onClose: () => void;
}) {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const [choice, setChoice] = useState<Choice | null>(null);
  const titleId = useId();
  // Setup picks the physical phone, so only Opensteer on the Mac it plugs into offers it.
  const iphoneSetup = hostClient.iphoneSetup;
  const deploymentId = DeploymentIdSchema.safeParse(snapshot.deploymentId);
  if (choice === "iphone-screen" && iphoneSetup && deploymentId.success)
    return (
      <AddIphoneDialog
        client={hostClient}
        deploymentId={deploymentId.data}
        deploymentName={snapshot.identityConfig?.deployment.name ?? "Opensteer"}
        onClose={onClose}
        port={iphoneSetup}
      />
    );
  if (choice === "agent-phone")
    return (
      <AddPhoneDialog
        client={hostClient}
        deploymentName={snapshot.identityConfig?.deployment.name ?? "Opensteer"}
        desktopBridge={desktopBridge}
        homeName={homeName}
        onClose={onClose}
      />
    );
  return (
    <Dialog
      footer={
        choice ? (
          <>
            <button className="btn btn--ghost" onClick={() => setChoice(null)} type="button">
              Back
            </button>
            <button className="btn" onClick={onClose} type="button">
              Done
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose} type="button">
            Cancel
          </button>
        )
      }
      labelledBy={titleId}
      onClose={onClose}
      title={<span id={titleId}>{choice ? choiceTitles[choice] : "Add a device"}</span>}
    >
      {choice === "mac" ? (
        <AddMac homeName={homeName} onPairing={() => setChoice("pairing")} />
      ) : choice === "phone" ? (
        <AddPhone homeName={homeName} />
      ) : choice === "chrome" ? (
        <AddChrome />
      ) : choice === "pairing" ? (
        <PairingCode homeName={homeName} />
      ) : choice === "iphone-screen" ? (
        <IphoneScreenOnMac />
      ) : choice === "server" ? (
        <AddServer />
      ) : (
        <div className="add-device__choices">
          {choices.map((option) => (
            <OptionRow
              as="button"
              detail={option.detail}
              framed
              key={option.id}
              leading={
                <span className="option-row__glyph option-row__glyph--outline">
                  <Icon name={option.icon} />
                </span>
              }
              onClick={() => setChoice(option.id)}
              title={option.title}
              trailing={<Icon name="chevron-right" />}
            />
          ))}
          <details className="settings-advanced add-device__advanced">
            <summary>Advanced</summary>
            <OptionRow
              as="button"
              detail="For a device that won’t sign in."
              framed
              leading={
                <span className="option-row__glyph option-row__glyph--outline">
                  <Icon name="devices" />
                </span>
              }
              onClick={() => setChoice("pairing")}
              title="Use a pairing code"
              trailing={<Icon name="chevron-right" />}
            />
          </details>
        </div>
      )}
    </Dialog>
  );
}

/** Setup picks the physical phone, so it happens only in Opensteer on the Mac it connects to. */
function IphoneScreenOnMac() {
  return (
    <div className="add-device__panel">
      <IphoneSetupOnMac />
    </div>
  );
}

/** Remote access off on a Mac's own Opensteer: nothing else can reach it, so it says so first. */
function useRemoteAccessOff(): boolean {
  const { hostClient, snapshot } = useShell();
  // A networked Home is reached at its own address; only a loopback one has Remote access.
  const networked = snapshot.identityConfig?.exposure === "networked";
  const remote = usePersonalRemoteAccess(networked ? null : hostClient);
  return remote.status?.access.mode === "off";
}

function RemoteAccessOffNotice({ homeName }: { readonly homeName: string }) {
  return useRemoteAccessOff() ? (
    <p className="notice" role="status">
      Turn on Remote access on {homeName} first, so the new device can reach it.
    </p>
  ) : null;
}

/** The Opensteer account's door to the Mac app: it sends the person to the current download. */
function macDownloadUrl(portalOrigin: string): string {
  return new URL("/mac", portalOrigin).toString();
}

/**
 * Adding a Mac, in the order a person does it. With an Opensteer account behind this Home, the
 * app comes from the account's own link, and signing in there lists this Home: opening it asks
 * "Connect this Mac to …", whose Connect makes the Mac one of the devices. A Home with no
 * Opensteer account has no such link or list: a pairing code connects the Mac instead.
 */
function AddMac({
  homeName,
  onPairing,
}: {
  readonly homeName: string;
  readonly onPairing: () => void;
}) {
  const { snapshot } = useShell();
  const portal = snapshot.identityConfig?.portalOrigin ?? null;
  const link = portal ? macDownloadUrl(portal) : null;
  // The name the Mac app lists this Home by, and asks to connect to.
  const name = snapshot.identityConfig?.deployment.name ?? homeName;
  const [copied, setCopied] = useState(false);
  if (!link)
    return (
      <div className="add-device__panel">
        <ol className="add-device__steps">
          <li>Install Opensteer on the Mac.</li>
          <li>Connect it to {homeName} with a pairing code.</li>
        </ol>
        <RemoteAccessOffNotice homeName={homeName} />
        <div className="add-device__pairing">
          <button className="btn btn--small" onClick={onPairing} type="button">
            Use a pairing code
          </button>
        </div>
      </div>
    );
  return (
    <div className="add-device__panel">
      <ol className="add-device__steps">
        <li>
          Install Opensteer on the Mac.
          <span className="add-device__get">
            <a className="btn btn--primary" href={link} rel="noopener noreferrer" target="_blank">
              <Icon name="download" />
              Get Opensteer for Mac
            </a>
            <button
              className="btn btn--small"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
              type="button"
            >
              <Icon name="copy" />
              {copied ? "Copied" : "Copy link"}
            </button>
          </span>
        </li>
        <li>Sign in with the same Opensteer account.</li>
        <li>{`Open ${name} there and choose Connect. You choose what your agent can use on the Mac.`}</li>
      </ol>
      <RemoteAccessOffNotice homeName={homeName} />
    </div>
  );
}

function AddPhone({ homeName }: { readonly homeName: string }) {
  const { snapshot } = useShell();
  const portal = snapshot.identityConfig?.portalOrigin ?? null;
  const link = portal && snapshot.deploymentId ? phoneOpenUrl(portal, snapshot.deploymentId) : null;
  const [copied, setCopied] = useState(false);
  return (
    <div className="add-device__panel">
      <p>Get the Opensteer app on the phone and sign in with the same Opensteer account.</p>
      <RemoteAccessOffNotice homeName={homeName} />
      {link ? (
        <div className="add-device__qr">
          <QrCode
            label={`Open ${snapshot.identityConfig?.deployment.name ?? "Opensteer"}`}
            value={link}
          />
          <div className="add-device__qr-text">
            <span>Scan with the phone’s camera, or send yourself the link.</span>
            <button
              className="btn btn--small"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
              type="button"
            >
              <Icon name="copy" />
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** For a device that won't sign in with the Opensteer account. */
function PairingCode({ homeName }: { readonly homeName: string }) {
  const { hostClient, snapshot } = useShell();
  // A networked Home is reached at its own address; pairing codes ride a loopback Home's route.
  const networked = snapshot.identityConfig?.exposure === "networked";
  const cloud = snapshot.identityConfig?.homeKind === "cloud-computer";
  const remote = usePersonalRemoteAccess(networked ? null : hostClient);
  const off = remote.status?.access.mode === "off";
  if (networked && cloud)
    return (
      <div className="add-device__panel">
        {/* A Cloud Computer has no password of its own: the Opensteer account is how in. */}
        <p>
          Open <code>{snapshot.identityConfig?.publicOrigin}</code> on it and sign in with your
          Opensteer account.
        </p>
      </div>
    );
  if (networked)
    return (
      <div className="add-device__panel">
        <p>
          Open <code>{snapshot.identityConfig?.publicOrigin}</code> on it and sign in with your
          password.
        </p>
      </div>
    );
  return (
    <div className="add-device__panel">
      {off ? (
        <p className="notice" role="status">
          Turn on Remote access on {homeName} first, so the new device can reach it.
        </p>
      ) : null}
      <div className="add-device__pairing">
        {remote.pairing ? (
          <p>
            Enter <code>{remote.pairing.code}</code> on the other device. It works once, until{" "}
            {new Date(remote.pairing.expiresAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            .
          </p>
        ) : (
          <button
            className="btn btn--small"
            disabled={!remote.pair || remote.working || off}
            onClick={() => void remote.pair?.()}
            type="button"
          >
            Create a pairing code
          </button>
        )}
        <SettingsError message={remote.actionError ?? null} />
      </div>
    </div>
  );
}

function AddServer() {
  const { hostClient, snapshot } = useShell();
  const [name, setName] = useState("Server");
  const [issued, setIssued] = useState<{
    readonly enrollmentId: string;
    readonly token: string;
    readonly hostOrigin: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const nameId = useId();
  const revision = import.meta.env.OPENSTEER_RUNNER_SOURCE_REVISION || undefined;
  const commands =
    issued && snapshot.deploymentShape && snapshot.identityConfig
      ? computerConnectionCommands({
          deploymentShape: snapshot.deploymentShape,
          enrollmentId: issued.enrollmentId,
          hostOrigin: issued.hostOrigin,
          name: name.trim(),
          token: issued.token,
          runnerDistribution: runnerDistributionPrefix(
            import.meta.env.OPENSTEER_RUNNER_ARTIFACT_BASE_URL || undefined,
            revision,
          ),
          runnerImage: runnerImageReference(revision),
        })
      : null;
  async function create() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const { target, result } = await act(
        hostClient,
        { label: "create this command", done: "created", happened: "this command was created" },
        async () => ({
          target: unwrapRpcResult(await hostClient.rpc["agentPhone.target.get"]({})),
          result: await hostClient.dispatch({
            allowedModules: [...localEnrollmentModules],
            idempotencyKey: mutationIdempotencyKey("server-add"),
            name: name.trim(),
            type: "runner.enrollment.createLocal",
          }),
        }),
      );
      if (result.type !== "runner.enrollment.createLocal") {
        setError("The command couldn’t be created.");
        return;
      }
      setIssued({ ...result, hostOrigin: target.hostUrl });
      setCancelled(false);
    } catch (reason) {
      setError(failureWords(reason));
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (pending || !issued) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await act(
        hostClient,
        { label: "cancel this setup", done: "cancelled", happened: "this setup was cancelled" },
        () => cancelDeviceSetup(hostClient, issued.enrollmentId),
      );
      if (outcome === "joined")
        setError(`${name.trim()} already joined. Remove it from Devices instead.`);
      else {
        setIssued(null);
        setCancelled(true);
      }
    } catch (reason) {
      setError(failureWords(reason));
    } finally {
      setPending(false);
    }
  }
  if (!commands)
    return (
      <div className="add-device__panel">
        {cancelled ? (
          <p className="notice" role="status">
            That command no longer works.
          </p>
        ) : null}
        <label className="field" htmlFor={nameId}>
          <span className="field__label">Name</span>
          <input
            className="text-input"
            id={nameId}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <button
          className="btn btn--primary"
          disabled={pending || !name.trim()}
          onClick={() => void create()}
          type="button"
        >
          {pending ? "Creating…" : "Create connection command"}
        </button>
        <SettingsError message={error} />
      </div>
    );
  return (
    <div className="add-device__panel">
      <p>Run one of these on {name.trim()}. It joins once, and the command then stops working.</p>
      <CommandBlock command={commands.container} label="With Docker" />
      {commands.bareHost ? (
        <CommandBlock command={commands.bareHost} label="Without Docker" />
      ) : null}
      <div>
        <button
          className="btn btn--small"
          disabled={pending}
          onClick={() => void cancel()}
          type="button"
        >
          {pending ? "Cancelling…" : "Cancel setup"}
        </button>
      </div>
      <SettingsError message={error} />
    </div>
  );
}

function CommandBlock({ command, label }: { readonly command: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="add-device__command">
      <div className="add-device__command-head">
        <span className="add-device__label">{label}</span>
        <button
          className="btn btn--small"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(command)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{command}</code>
      </pre>
    </div>
  );
}
