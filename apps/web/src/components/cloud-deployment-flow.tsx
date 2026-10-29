import { useState, type FormEvent } from "react";
import type { DeploymentId } from "@opensteer/core";
import { ErrorNotice, OnboardingCard } from "./onboarding-card.js";
import { Icon } from "./icon.js";
import { OptionRow } from "./option-row.js";

export interface CloudDeploymentOperationView {
  readonly deploymentId: DeploymentId;
  readonly desiredState: "present" | "deleted";
  readonly error: string | null;
  readonly name: string;
  readonly operationId: string;
  readonly status: "creating" | "ready" | "failed" | "deleting" | "deleted";
}

interface CloudDeploymentFlowProps {
  readonly available: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onCreate: (name: string) => Promise<void>;
  readonly onDelete: (operationId: string, name: string) => Promise<void>;
  readonly onOpen: (deploymentId: DeploymentId) => Promise<void> | void;
  readonly onRetry: (operationId: string) => Promise<void>;
  readonly operations: readonly CloudDeploymentOperationView[];
}

export function CloudDeploymentFlow({
  available,
  error,
  onBack,
  onCreate,
  onDelete,
  onOpen,
  onRetry,
  operations,
}: CloudDeploymentFlowProps) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<CloudDeploymentOperationView | null>(
    null,
  );
  const [confirmationName, setConfirmationName] = useState("");

  async function run(key: string, action: () => Promise<void>) {
    if (pending) return;
    setPending(key);
    setActionError(null);
    try {
      await action();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Opensteer Cloud could not complete that action.",
      );
    } finally {
      setPending(null);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const deploymentName = name.trim();
    if (!deploymentName) return;
    void run("create", async () => {
      await onCreate(deploymentName);
      setName("");
    });
  }

  return (
    <OnboardingCard
      bare
      description="Always on, so agents keep working while your computer sleeps. Opensteer runs it for you."
      live
      title="Opensteer Cloud"
    >
      {available ? (
        <form className="add-deployment__form" onSubmit={create}>
          <label className="field" htmlFor="cloud-deployment-name">
            <span className="field__label">Name</span>
            <input
              autoComplete="off"
              className="text-input"
              disabled={pending !== null}
              id="cloud-deployment-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="My Opensteer"
              required
              value={name}
            />
          </label>
          <button className="btn btn--primary" disabled={pending !== null} type="submit">
            {pending === "create" ? "Creating…" : "Create"}
          </button>
        </form>
      ) : null}
      {operations.length > 0 ? (
        <ul aria-label="Your Opensteer Cloud" className="desktop-deployment-list">
          {operations
            .filter(({ status }) => status !== "deleted")
            .map((operation) => (
              <CloudOperationRow
                key={operation.operationId}
                manageable={available}
                onDelete={() => {
                  setDeleteConfirmation(operation);
                  setConfirmationName("");
                  setActionError(null);
                }}
                onOpen={() => {
                  void run(
                    operation.operationId,
                    async () => void (await onOpen(operation.deploymentId)),
                  );
                }}
                onRetry={() => {
                  void run(operation.operationId, () => onRetry(operation.operationId));
                }}
                operation={operation}
                pending={pending === operation.operationId}
              />
            ))}
        </ul>
      ) : null}
      {deleteConfirmation ? (
        <form
          className="add-deployment__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!cloudDeletionNameMatches(deleteConfirmation.name, confirmationName)) {
              setActionError(`Enter “${deleteConfirmation.name}” to confirm deletion.`);
              return;
            }
            void run(deleteConfirmation.operationId, async () => {
              await onDelete(deleteConfirmation.operationId, confirmationName);
              setDeleteConfirmation(null);
              setConfirmationName("");
            });
          }}
        >
          <p>
            Delete <strong>{deleteConfirmation.name}</strong> and permanently remove its hosted
            data. Enter its name to confirm.
          </p>
          <label className="field" htmlFor="cloud-deployment-delete-name">
            <span className="field__label">Deployment name</span>
            <input
              autoComplete="off"
              autoFocus
              className="text-input"
              disabled={pending !== null}
              id="cloud-deployment-delete-name"
              onChange={(event) => setConfirmationName(event.target.value)}
              value={confirmationName}
            />
          </label>
          <div className="button-row">
            <button
              className="btn btn--danger"
              disabled={
                pending !== null ||
                !cloudDeletionNameMatches(deleteConfirmation.name, confirmationName)
              }
              type="submit"
            >
              {pending === deleteConfirmation.operationId ? "Deleting…" : "Delete"}
            </button>
            <button
              className="btn btn--ghost"
              disabled={pending !== null}
              onClick={() => {
                setDeleteConfirmation(null);
                setConfirmationName("");
                setActionError(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <ErrorNotice message={actionError ?? error} />
      <button
        className="btn btn--ghost onboarding__back"
        disabled={pending !== null}
        onClick={onBack}
        type="button"
      >
        <Icon name="arrow-left" />
        Back
      </button>
    </OnboardingCard>
  );
}

export function cloudDeletionNameMatches(expected: string, entered: string): boolean {
  return entered === expected;
}

function CloudOperationRow({
  manageable,
  onDelete,
  onOpen,
  onRetry,
  operation,
  pending,
}: {
  readonly manageable: boolean;
  readonly onDelete: () => void;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly operation: CloudDeploymentOperationView;
  readonly pending: boolean;
}) {
  const working = operation.status === "creating" || operation.status === "deleting";
  const action =
    operation.status === "ready" ? (
      <>
        <button className="btn btn--small" disabled={pending} onClick={onOpen} type="button">
          Open
        </button>
        {manageable ? (
          <button
            className="btn btn--danger btn--small"
            disabled={pending}
            onClick={onDelete}
            type="button"
          >
            Delete
          </button>
        ) : null}
      </>
    ) : operation.status === "failed" && manageable ? (
      <>
        <button className="btn btn--small" disabled={pending} onClick={onRetry} type="button">
          {operation.desiredState === "deleted" ? "Retry deletion" : "Retry"}
        </button>
        {operation.desiredState === "present" ? (
          <button
            className="btn btn--danger btn--small"
            disabled={pending}
            onClick={onDelete}
            type="button"
          >
            Delete
          </button>
        ) : null}
      </>
    ) : operation.status === "failed" ? (
      <span className="chip chip--warn">Needs attention</span>
    ) : (
      <span className="chip">{operation.status === "deleting" ? "Deleting…" : "Creating…"}</span>
    );
  return (
    <li>
      <OptionRow
        as="content"
        detail={
          operation.error ??
          (operation.status === "deleting"
            ? "Opensteer is deleting it."
            : working
              ? "Opensteer is setting it up."
              : "Ready to open.")
        }
        leading={
          <span className="option-row__glyph option-row__glyph--outline">
            <Icon name="cloud" />
          </span>
        }
        title={operation.name}
        trailing={action}
      />
    </li>
  );
}
