import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  cloudComputerEntryDetail,
  cloudComputerDeleteInput,
  cloudComputerWebsite,
  cloudWords,
  type CloudComputerDetail,
  type CloudComputerTone,
} from "@opensteer/client/computers";
import type { CloudComputerAccount } from "@opensteer/client/connections";
import { useCloudComputer } from "@opensteer/client/react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useShell } from "../../app-shell.js";
import { CopyBlock } from "../../copy-block.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { SectionHeader, SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";
import { SetupSteps, WorkHomeCards, WorkHomeRow, useWorkHomeBadge } from "./work-home.js";
import { useHomeKind } from "../../devices/home-facts.js";

export const cloudComputerPath = "/settings/account/cloud-computer";

const accounts = new WeakMap<OpensteerDesktopBridge, CloudComputerAccount>();

/**
 * The person's Cloud Computers through the Account this app is signed in to: main's
 * Account client on desktop. A browser tab holds no Account credential, so it has none
 * and sends the person to the Opensteer website instead.
 */
export function useCloudComputerAccount(): CloudComputerAccount | null {
  const { desktopBridge } = useShell();
  return useMemo(() => cloudComputerAccountFor(desktopBridge), [desktopBridge]);
}

/** The one Cloud Computer account for a desktop bridge, so every screen shares its read. */
export function cloudComputerAccountFor(
  desktopBridge: OpensteerDesktopBridge | null | undefined,
): CloudComputerAccount | null {
  if (!desktopBridge?.cloudComputerRead || !desktopBridge.cloudComputerAct) return null;
  let account = accounts.get(desktopBridge);
  if (!account) {
    const read = desktopBridge.cloudComputerRead.bind(desktopBridge);
    const act = desktopBridge.cloudComputerAct.bind(desktopBridge);
    account = { read, act };
    accounts.set(desktopBridge, account);
  }
  return account;
}

function useOpenWebsite() {
  const { desktopBridge } = useShell();
  return (url: string) => {
    if (desktopBridge) void desktopBridge.openExternalUrl({ url });
    else window.open(url, "_blank", "noopener,noreferrer");
  };
}

/**
 * The row that leads to the Cloud Computer: in Account settings, and on a Mac Home's
 * page. A server or Cloud Computer Home never shows it as an offer.
 */
export function CloudComputerEntryRow() {
  const kind = useHomeKind().kind;
  return (
    <SettingsRow
      title={cloudWords("cloud.entry.title")}
      detail={cloudComputerEntryDetail(kind)}
      action={
        <Link className="btn btn--small" to={cloudComputerPath}>
          <Icon name="cloud" />
          {cloudWords("cloud.shortTitle")}
        </Link>
      }
    />
  );
}

/** Opensteer Cloud Computer: what it is and its price, then setting up, then its status. */
export function CloudComputerPage() {
  const shell = useShell();
  const account = useCloudComputerAccount();
  const cloud = useCloudComputer(account);
  const portalOrigin = shell.snapshot.identityConfig?.portalOrigin ?? null;
  const openWebsite = useOpenWebsite();
  const refresh = cloud.refresh;
  // The status read is the truth: coming back from checkout, by any route, reads it again.
  useEffect(() => {
    if (!refresh) return;
    const again = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [refresh]);
  const back = (
    <Link className="settings-link connected-agent__back" to="/settings/account">
      <Icon name="chevron-left" />
      Account
    </Link>
  );
  if (!account)
    return (
      <>
        {back}
        <SectionHeader title={cloudWords("cloud.title")} lead={cloudWords("cloud.lead")} />
        <WhatItIs />
        <SettingsGroup heading={null} headingId="cloud-computer-website">
          <SettingsRow
            title={cloudWords("cloud.account.website")}
            action={
              portalOrigin ? (
                <button
                  className="btn btn--small"
                  onClick={() => openWebsite(cloudComputerWebsite(portalOrigin, "home"))}
                  type="button"
                >
                  {cloudWords("cloud.account.openWebsite")}
                </button>
              ) : undefined
            }
          />
        </SettingsGroup>
      </>
    );
  const { screen } = cloud;
  const checkout = () => {
    if (!portalOrigin) return;
    openWebsite(cloudComputerWebsite(portalOrigin, "checkout"));
    cloud.checkoutOpened?.();
  };
  return (
    <>
      {back}
      <SectionHeader title={cloudWords("cloud.title")} lead={cloudWords("cloud.lead")} />
      {screen.kind === "loading" ? <p role="status">{cloudWords("cloud.loading")}</p> : null}
      <WorkHomeCards cards={cloud.work} />
      {screen.kind === "failed" ? (
        <AccountFailure
          kind={screen.failure.kind}
          message={screen.failure.message}
          onRetry={() => void refresh?.()}
        />
      ) : null}
      {screen.kind === "offer" ? (
        <>
          {screen.deleted ? (
            <p className="notice" role="status">
              {cloudWords("cloud.deleted")}
            </p>
          ) : null}
          {screen.waiting ? (
            <div className="notice" role="status">
              <Icon name="external-link" />
              <div>
                <strong className="connected-agent__status-label">
                  {cloudWords("cloud.checkoutWaiting.title")}
                </strong>
                {cloudWords("cloud.checkoutWaiting.detail")}
              </div>
            </div>
          ) : null}
          <WhatItIs />
          <SettingsGroup heading={null} headingId="cloud-computer-price">
            <SettingsRow
              className="cloud-computer__price"
              title={screen.plan.line}
              detail={cloudWords("cloud.priceDetail")}
            />
          </SettingsGroup>
          <SettingsGroup
            heading={cloudWords("cloud.changes.title")}
            headingId="cloud-computer-changes"
          >
            <SettingsRow title={cloudWords("cloud.changes.detail")} />
          </SettingsGroup>
          <div className="form-actions">
            <Link className="btn" to="/settings/account">
              {cloudWords("cloud.notNow")}
            </Link>
            <button
              className="btn btn--primary"
              disabled={!portalOrigin}
              onClick={checkout}
              type="button"
            >
              {screen.waiting ? cloudWords("cloud.checkoutAgain") : cloudWords("cloud.checkout")}
            </button>
          </div>
        </>
      ) : null}
      {screen.kind === "preparing" ? (
        <>
          <div className="notice connected-agent__status" role="status">
            <span aria-hidden className="status-dot status-dot--idle" />
            <div>
              <strong className="connected-agent__status-label">
                {cloudWords("cloud.preparing.title")}
              </strong>
              {screen.computer.steps ? (
                <SetupSteps steps={screen.computer.steps} />
              ) : (
                <ol className="connected-agent__steps">
                  <li data-state="current">
                    <span aria-hidden />
                    {cloudWords("cloud.step.machine")}
                  </li>
                  <li data-state="pending">
                    <span aria-hidden />
                    {cloudWords("cloud.step.ready")}
                  </li>
                </ol>
              )}
            </div>
          </div>
          <p className="settings-footnote">
            {cloudWords("cloud.step.machineDetail")} {cloudWords("cloud.preparing.footer")}
          </p>
          <SettingsGroup
            heading={cloudWords("cloud.changes.title")}
            headingId="cloud-computer-changes"
          >
            <SettingsRow title={cloudWords("cloud.changes.detail")} />
          </SettingsGroup>
        </>
      ) : null}
      {screen.kind === "computer" ? (
        <ComputerStatus
          actionFailure={cloud.actionFailure}
          computer={screen.computer}
          onAct={(input) => void cloud.act?.(input)}
          onBilling={
            portalOrigin ? () => openWebsite(cloudComputerWebsite(portalOrigin, "billing")) : null
          }
          pending={cloud.pending}
          planLine={screen.plan.line}
        />
      ) : null}
    </>
  );
}

function WhatItIs() {
  const points = [
    ["moon", "cloud.point.awake.title", "cloud.point.awake.detail"],
    ["globe", "cloud.point.ip.title", "cloud.point.ip.detail"],
    ["shield", "cloud.point.backup.title", "cloud.point.backup.detail"],
    ["laptop", "cloud.point.mac.title", "cloud.point.mac.detail"],
  ] as const;
  return (
    <SettingsGroup heading={null} headingId="cloud-computer-points">
      {points.map(([icon, title, detail]) => (
        <div className="card__row" key={title}>
          <span aria-hidden className="card__row-glyph">
            <Icon name={icon} />
          </span>
          <span className="card__row-body">
            <span className="card__row-title">{cloudWords(title)}</span>
            <span className="card__row-detail">{cloudWords(detail)}</span>
          </span>
        </div>
      ))}
    </SettingsGroup>
  );
}

function AccountFailure({
  kind,
  message,
  onRetry,
}: {
  readonly kind: "signed-out" | "unreachable" | "refused" | "unavailable";
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className={kind === "unavailable" ? "notice" : "notice notice--error"} role="alert">
      <Icon name="alert-circle" />
      <div>{message}</div>
      {kind === "signed-out" ? (
        <Link className="btn btn--small" to="/settings/account">
          {cloudWords("cloud.account.signIn")}
        </Link>
      ) : kind === "unavailable" ? null : (
        <button className="btn btn--small" onClick={onRetry} type="button">
          {cloudWords("cloud.tryAgain")}
        </button>
      )}
    </div>
  );
}

function dotTone(tone: CloudComputerTone): string {
  return tone === "good" ? "ok" : tone === "neutral" ? "idle" : "warn";
}

function ComputerStatus({
  actionFailure,
  computer,
  onAct,
  onBilling,
  pending,
  planLine,
}: {
  readonly actionFailure: string | null;
  readonly computer: CloudComputerDetail;
  readonly onAct: (
    input:
      | NonNullable<ReturnType<typeof cloudComputerDeleteInput>>
      | {
          readonly action: "suspend" | "resume";
          readonly id: CloudComputerDetail["id"];
        },
  ) => void;
  readonly onBilling: (() => void) | null;
  readonly pending: "suspend" | "resume" | "delete" | null;
  readonly planLine: string;
}) {
  const [confirming, setConfirming] = useState<"suspend" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const busy = pending !== null;
  const remove = cloudComputerDeleteInput(computer.id, typed);
  return (
    <>
      {computer.address ? (
        <ReadyActions address={computer.address} deploymentId={computer.deploymentId} />
      ) : null}
      <SettingsGroup heading={cloudWords("cloud.status.title")} headingId="cloud-computer-status">
        <div className="card__row">
          <span aria-hidden className={`status-dot status-dot--${dotTone(computer.status.tone)}`} />
          <span className="card__row-body">
            <span className="card__row-title">{computer.status.label}</span>
            {computer.status.reason ? (
              <span className="card__row-detail">{computer.status.reason}</span>
            ) : null}
          </span>
        </div>
        {computer.address ? (
          <div className="card__form">
            <CopyBlock label={cloudWords("cloud.address")} value={computer.address} />
          </div>
        ) : null}
        <div className="card__row">
          <span
            aria-hidden
            className={`status-dot status-dot--${dotTone(computer.browserIp.tone)}`}
          />
          <span className="card__row-body">
            <span className="card__row-title">
              {cloudWords("cloud.ip.title")} · {computer.browserIp.label}
            </span>
            <span className="card__row-detail">{computer.browserIp.detail}</span>
          </span>
        </div>
        {computer.browserAddress ? (
          <SettingsRow title={cloudWords("cloud.ip.address")} detail={computer.browserAddress} />
        ) : null}
        {computer.lastBackup ? (
          <SettingsRow title={cloudWords("cloud.backup.reported")} detail={computer.lastBackup} />
        ) : null}
        {computer.region ? (
          <SettingsRow title={cloudWords("cloud.region")} detail={computer.region} />
        ) : null}
      </SettingsGroup>
      <SettingsGroup heading={cloudWords("cloud.plan.title")} headingId="cloud-computer-plan">
        <SettingsRow
          detail={computer.renews ?? undefined}
          title={planLine}
          action={
            onBilling ? (
              <button className="btn btn--small" onClick={onBilling} type="button">
                {cloudWords("cloud.plan.manage")}
              </button>
            ) : undefined
          }
        />
      </SettingsGroup>
      <SettingsGroup heading={null} headingId="cloud-computer-power">
        {computer.canSuspend ? (
          <SettingsRow
            title={cloudWords("cloud.suspend")}
            detail={cloudWords("cloud.suspend.detail")}
            action={
              <button
                className="btn btn--small"
                disabled={busy}
                onClick={() => setConfirming("suspend")}
                type="button"
              >
                {pending === "suspend"
                  ? cloudWords("cloud.suspending")
                  : cloudWords("cloud.suspend")}
              </button>
            }
          />
        ) : null}
        {computer.canResume ? (
          <SettingsRow
            title={cloudWords("cloud.resume")}
            action={
              <button
                className="btn btn--small btn--primary"
                disabled={busy}
                onClick={() => onAct({ action: "resume", id: computer.id })}
                type="button"
              >
                {pending === "resume" ? cloudWords("cloud.resuming") : cloudWords("cloud.resume")}
              </button>
            }
          />
        ) : null}
      </SettingsGroup>
      <SettingsError message={actionFailure} />
      {computer.canDelete ? (
        <div className="connected-agent__end">
          <button
            className="btn btn--danger"
            disabled={busy}
            onClick={() => {
              setTyped("");
              setConfirming("delete");
            }}
            type="button"
          >
            {pending === "delete" ? cloudWords("cloud.deleting") : cloudWords("cloud.delete")}
          </button>
        </div>
      ) : null}
      {confirming === "suspend" ? (
        <Dialog
          title={cloudWords("cloud.suspend.title")}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setConfirming(null);
                  onAct({ action: "suspend", id: computer.id });
                }}
                type="button"
              >
                {cloudWords("cloud.suspend")}
              </button>
            </>
          }
        >
          <p>{cloudWords("cloud.suspend.body")}</p>
        </Dialog>
      ) : null}
      {confirming === "delete" ? (
        <Dialog
          title={cloudWords("cloud.delete.title")}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={remove === null}
                onClick={() => {
                  if (!remove) return;
                  setConfirming(null);
                  onAct(remove);
                }}
                type="button"
              >
                {cloudWords("cloud.delete.confirm")}
              </button>
            </>
          }
        >
          <p>{cloudWords("cloud.delete.body")}</p>
          <label className="field">
            <span className="field__label">{cloudWords("cloud.delete.typeToConfirm")}</span>
            <input
              autoComplete="off"
              className="text-input"
              onChange={(event) => setTyped(event.target.value)}
              value={typed}
            />
          </label>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * Ready: open it, connect agents to it, and on desktop connect this Mac as one of its
 * Devices. Each uses the app's existing paths: the Account lists the Cloud Computer as
 * a Home, and opening a Home this Mac doesn't host offers the existing "Set up this Mac".
 */
function ReadyActions({
  address,
  deploymentId,
}: {
  readonly address: string;
  readonly deploymentId: string | null;
}) {
  const { deploymentAccess, desktopBridge } = useShell();
  const navigate = useNavigate();
  // The Account names the Home it pinned; until it has, the Home isn't listed yet.
  const listed =
    deploymentId === null
      ? null
      : (deploymentAccess?.deployments.find((deployment) => deployment.id === deploymentId) ??
        null);
  const open = (path: string | null) => {
    if (!desktopBridge) {
      window.open(address, "_blank", "noopener,noreferrer");
      return;
    }
    if (!listed) return;
    if (path) void navigate(path);
    void desktopBridge.select({ deploymentId: listed.id });
  };
  const unlisted = desktopBridge !== null && listed === null;
  return (
    <SettingsGroup heading={null} headingId="cloud-computer-ready">
      <SettingsRow
        title={
          <>
            <Icon name="check-circle" />
            {cloudWords("cloud.ready.title")}
          </>
        }
        detail={unlisted ? cloudWords("cloud.ready.notListed") : new URL(address).host}
        action={
          <button
            className="btn btn--small btn--primary"
            disabled={unlisted}
            onClick={() => open(null)}
            type="button"
          >
            {cloudWords("cloud.ready.open")}
          </button>
        }
      />
      {desktopBridge ? (
        <>
          <SettingsRow
            title={cloudWords("cloud.ready.reconnect")}
            action={
              <button
                className="btn btn--small"
                disabled={unlisted}
                onClick={() => open("/settings/external-agents")}
                type="button"
              >
                {cloudWords("cloud.ready.start")}
              </button>
            }
          />
          <SettingsRow
            title={cloudWords("cloud.ready.thisMac")}
            detail={cloudWords("cloud.ready.thisMacDetail")}
            action={
              <button
                className="btn btn--small"
                disabled={unlisted}
                onClick={() => open("/settings/devices")}
                type="button"
              >
                {cloudWords("cloud.ready.start")}
              </button>
            }
          />
        </>
      ) : null}
    </SettingsGroup>
  );
}

/**
 * The Cloud Computer on a Home's own page: offered on a Mac Home; on a networked Home,
 * shown only when it is the person's Cloud Computer, with its status; never on a server.
 */
export function HomeCloudComputerRow() {
  const { desktopDeployment, snapshot } = useShell();
  const work = useWorkHomeBadge(desktopDeployment?.id);
  if (work) return <WorkHomeRow card={work} />;
  const exposure = snapshot.identityConfig?.exposure;
  if (exposure !== "networked")
    return (
      <SettingsGroup heading={null} headingId="device-home-cloud">
        <CloudComputerEntryRow />
      </SettingsGroup>
    );
  return <NetworkedHomeCloudRow deploymentId={desktopDeployment?.id ?? null} />;
}

function NetworkedHomeCloudRow({ deploymentId }: { readonly deploymentId: string | null }) {
  const account = useCloudComputerAccount();
  const cloud = useCloudComputer(account);
  const screen = cloud.screen;
  if (screen.kind !== "computer" && screen.kind !== "preparing") return null;
  if (deploymentId === null || screen.computer.deploymentId !== deploymentId) return null;
  return (
    <SettingsGroup heading={null} headingId="device-home-cloud">
      <SettingsRow
        title={cloudWords("cloud.entry.title")}
        detail={screen.computer.status.label}
        action={
          <Link className="btn btn--small" to={cloudComputerPath}>
            {cloudWords("cloud.status.title")}
          </Link>
        }
      />
    </SettingsGroup>
  );
}
