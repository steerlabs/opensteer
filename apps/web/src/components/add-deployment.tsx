import { useState, type FormEvent } from "react";
import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { Icon } from "./icon.js";
import { ErrorNotice, OnboardingCard } from "./onboarding-card.js";
import {
  DeploymentChoices,
  deploymentChoiceOrder,
  type DeploymentChoice,
} from "./deployment-choices.js";

type AddOption = Extract<DeploymentChoice, "computer" | "server"> | null;

/**
 * The one screen for getting another place into this app.
 *
 * The things a person can actually add are rows, each saying what it is; what
 * one needs appears inside its own row when it is chosen, so nothing has to be
 * answered twice. Another computer is added *on that computer*, by turning on
 * Remote access with the same account — so its row says exactly that first,
 * and keeps a pairing code for computers not signed in to an account.
 */
interface AddDeploymentProps {
  readonly accountEmail?: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onConnect: (input: DesktopConnectPrivateDeploymentInput) => void;
  readonly onCreateCloud?: (() => void) | null;
  readonly onCreatePersonal?: (() => void) | null;
  readonly onManageCloud?: (() => void) | null;
  /** Present when this app can sign in to the Account and is not signed in. */
  readonly onSignIn?: (() => void) | null;
}

export function AddDeployment({
  accountEmail = null,
  busy,
  error,
  onBack,
  onConnect,
  onCreateCloud = null,
  onCreatePersonal = null,
  onManageCloud = null,
  onSignIn = null,
}: AddDeploymentProps) {
  const [option, setOption] = useState<AddOption>(null);
  const [computerOrigin, setComputerOrigin] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [serverOrigin, setServerOrigin] = useState("");
  const [pairing, setPairing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function open(next: Exclude<AddOption, null>) {
    setOption((current) => (current === next ? null : next));
    setFormError(null);
  }

  function choose(choice: DeploymentChoice) {
    if (choice === "local") return onCreatePersonal?.();
    if (choice === "cloud") return onCreateCloud?.();
    open(choice);
  }

  /* The pairing code and origin are branded once, by the schema, so the form
     never has to claim a shape the machine has not accepted. */
  function submit(event: FormEvent<HTMLFormElement>, input: unknown) {
    event.preventDefault();
    if (busy) return;
    const parsed = DesktopConnectPrivateDeploymentInputSchema.safeParse(input);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Enter a valid Opensteer address.");
      return;
    }
    setFormError(null);
    onConnect(parsed.data);
  }

  return (
    <OnboardingCard
      bare
      description={
        onCreateCloud
          ? "Your agents can also work on your other computers, a server, or Opensteer Cloud."
          : "Your agents can also work on your other computers or a server."
      }
      live
      title="Add a computer or server"
    >
      <DeploymentChoices
        busy={busy}
        expanded={option}
        onChoose={choose}
        options={deploymentChoiceOrder({
          canConnect: true,
          canCreateCloud: onCreateCloud !== null,
          canCreateLocal: onCreatePersonal !== null,
        })}
        renderExpanded={(choice) =>
          choice === "computer" && !pairing && (accountEmail !== null || onSignIn !== null) ? (
            <div className="add-deployment__form">
              <p className="field__hint">
                On that computer, open Opensteer, go to Settings › Remote access and turn it on
                {accountEmail ? ` with ${accountEmail}` : " with your account"}. It then appears in
                your list here by itself.
              </p>
              {onSignIn ? (
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={onSignIn}
                  type="button"
                >
                  Sign in here too
                </button>
              ) : null}
              <button className="link-btn" onClick={() => setPairing(true)} type="button">
                Use a pairing code instead
              </button>
            </div>
          ) : choice === "computer" ? (
            <form
              className="add-deployment__form"
              onSubmit={(event) =>
                submit(event, {
                  kind: "personal-pairing",
                  origin: computerOrigin.trim(),
                  pairingCode: pairingCode.trim(),
                })
              }
            >
              <label className="field" htmlFor="add-deployment-computer-origin">
                <span className="field__label">Address of that computer</span>
                <input
                  autoCapitalize="none"
                  autoComplete="url"
                  className="text-input"
                  disabled={busy}
                  id="add-deployment-computer-origin"
                  inputMode="url"
                  onChange={(event) => setComputerOrigin(event.target.value)}
                  placeholder="https://mac-mini.example.ts.net"
                  required
                  spellCheck={false}
                  type="url"
                  value={computerOrigin}
                />
              </label>
              <label className="field" htmlFor="add-deployment-pairing-code">
                <span className="field__label">Pairing code</span>
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="text-input"
                  disabled={busy}
                  id="add-deployment-pairing-code"
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="osp_…"
                  required
                  spellCheck={false}
                  type="text"
                  value={pairingCode}
                />
                <span className="field__hint">
                  Create a pairing code in Settings › Remote access on that computer after enabling
                  Private network. One use, and it expires shortly.
                </span>
              </label>
              <button className="btn btn--primary" disabled={busy} type="submit">
                {busy ? "Verifying…" : "Connect"}
                {busy ? null : <Icon name="arrow-right" />}
              </button>
            </form>
          ) : choice === "server" ? (
            <form
              className="add-deployment__form"
              onSubmit={(event) =>
                submit(event, { kind: "self-hosted", origin: serverOrigin.trim() })
              }
            >
              <label className="field" htmlFor="add-deployment-server-origin">
                <span className="field__label">Server address</span>
                <input
                  autoCapitalize="none"
                  autoComplete="url"
                  className="text-input"
                  disabled={busy}
                  id="add-deployment-server-origin"
                  inputMode="url"
                  onChange={(event) => setServerOrigin(event.target.value)}
                  placeholder="https://opensteer.example.com"
                  required
                  spellCheck={false}
                  type="url"
                  value={serverOrigin}
                />
                <span className="field__hint">Use the HTTPS address its owner gave you.</span>
              </label>
              <button className="btn btn--primary" disabled={busy} type="submit">
                {busy ? "Verifying…" : "Connect"}
                {busy ? null : <Icon name="arrow-right" />}
              </button>
            </form>
          ) : null
        }
      />
      {onManageCloud ? (
        <p className="onboarding__switch">
          <button disabled={busy} onClick={onManageCloud} type="button">
            Manage Opensteer Cloud
          </button>
        </p>
      ) : null}
      <ErrorNotice message={formError ?? error} />
      <button className="btn btn--ghost onboarding__back" onClick={onBack} type="button">
        <Icon name="arrow-left" />
        Back
      </button>
    </OnboardingCard>
  );
}
