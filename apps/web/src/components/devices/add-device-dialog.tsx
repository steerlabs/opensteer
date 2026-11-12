import { useId, useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import {
  computerConnectionCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { AddPhoneDialog } from "../computers/add-phone-dialog.js";
import { Dialog } from "../dialog.js";
import { phoneOpenUrl } from "../first-run/phone-setup.js";
import { QrCode } from "../first-run/qr-code.js";
import { Icon, type IconName } from "../icon.js";
import { OptionRow } from "../option-row.js";
import { SettingsError } from "../settings/primitives.js";
import { localEnrollmentModules } from "./this-device.js";

type Choice = "sign-in" | "agent-phone" | "server";

const choices: readonly {
  readonly id: Choice;
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    id: "sign-in",
    icon: "devices",
    title: "Sign in on it",
    detail:
      "A Mac or phone with the Opensteer app. Scan a code, open a link or use a pairing code.",
  },
  {
    id: "agent-phone",
    icon: "phone",
    title: "Agent Phone",
    detail: "An Android phone you give to your agent, set up over USB.",
  },
  {
    id: "server",
    icon: "server",
    title: "Server",
    detail: "A computer without a screen, connected with one command.",
  },
];

/** The three ways a device joins, each opening in place. */
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
      title={
        <span id={titleId}>
          {choice === "sign-in"
            ? "Sign in on it"
            : choice === "server"
              ? "Add a server"
              : "Add a device"}
        </span>
      }
    >
      {choice === "sign-in" ? (
        <SignInOnIt homeName={homeName} />
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
        </div>
      )}
    </Dialog>
  );
}

function SignInOnIt({ homeName }: { readonly homeName: string }) {
  const { hostClient, snapshot } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const portal = snapshot.identityConfig?.portalOrigin ?? null;
  const link = portal && snapshot.deploymentId ? phoneOpenUrl(portal, snapshot.deploymentId) : null;
  const [copied, setCopied] = useState(false);
  const off = remote.status?.access.mode === "off";
  return (
    <div className="add-device__panel">
      <p>
        Install Opensteer on it and sign in with the same account. It sets itself up as one of your
        devices.
      </p>
      {off ? (
        <p className="notice" role="status">
          Turn on Use from anywhere on {homeName} first, so the new device can reach it.
        </p>
      ) : null}
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
      <div className="add-device__pairing">
        <span className="add-device__label">No account on it?</span>
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
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const revision = import.meta.env.OPENSTEER_RUNNER_SOURCE_REVISION || undefined;
  const commands =
    issued && snapshot.deploymentShape && snapshot.identityConfig
      ? computerConnectionCommands({
          deploymentShape: snapshot.deploymentShape,
          enrollmentId: issued.enrollmentId,
          hostOrigin: snapshot.identityConfig.publicOrigin,
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
      const result = await hostClient.dispatch({
        allowedModules: [...localEnrollmentModules],
        idempotencyKey: mutationIdempotencyKey("server-add"),
        name: name.trim(),
        type: "runner.enrollment.createLocal",
      });
      if (result.type !== "runner.enrollment.createLocal")
        throw new Error("The command couldn’t be created.");
      setIssued(result);
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  if (!commands)
    return (
      <div className="add-device__panel">
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
