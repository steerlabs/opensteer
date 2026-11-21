import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import {
  cloudComputerDeployments,
  cloudWords,
  orgWords,
  workHomeBadges,
  type CloudComputerStepView,
  type WorkHomeCard,
} from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import { useShell } from "../../app-shell.js";
import { CopyBlock } from "../../copy-block.js";
import { Icon } from "../../icon.js";
import { SettingsGroup, SettingsRow } from "../primitives.js";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { cloudComputerAccountFor, useCloudComputerAccount } from "./cloud-computer.js";

/**
 * "What {organization} can see": one page, read from the work Home itself, so it is shown
 * from inside that Home (on the web too, where no Account read of work Homes exists).
 */
export const workHomeSeePath = "/settings/work";

/** The person's work Homes, from the same one read as their Cloud Computer screen. */
export function useWorkHomes(): readonly WorkHomeCard[] {
  return useCloudComputer(useCloudComputerAccount()).work;
}

/** Each listed work Home's "Work · {organization}" badge, by Home, for a list of places. */
export function usePlaceWorkBadges(
  bridge: OpensteerDesktopBridge | null | undefined,
): ReadonlyMap<string, string> {
  const account = useMemo(() => cloudComputerAccountFor(bridge), [bridge]);
  const work = useCloudComputer(account).work;
  return useMemo(
    () => new Map([...workHomeBadges(work)].map(([id, card]) => [id, card.badge])),
    [work],
  );
}

/** The listed Homes the Account says are Opensteer Cloud Computers, for a list of places. */
export function usePlaceCloudComputers(
  bridge: OpensteerDesktopBridge | null | undefined,
): ReadonlySet<string> {
  const account = useMemo(() => cloudComputerAccountFor(bridge), [bridge]);
  const views = useCloudComputer(account).views;
  return useMemo(() => cloudComputerDeployments(views), [views]);
}

/** "Work · {organization}" for the listed Home that is a work Home, if any. */
export function useWorkHomeBadge(deploymentId: string | null | undefined): WorkHomeCard | null {
  const work = useWorkHomes();
  if (!deploymentId) return null;
  return workHomeBadges(work).get(deploymentId) ?? null;
}

export function WorkBadge({ card }: { readonly card: WorkHomeCard }) {
  return (
    <span className="work-badge" title={card.managed}>
      <Icon name="users" />
      {card.badge}
    </span>
  );
}

function dotTone(tone: WorkHomeCard["status"]["tone"]): string {
  return tone === "good" ? "ok" : tone === "neutral" ? "idle" : "warn";
}

export function SetupSteps({ steps }: { readonly steps: readonly CloudComputerStepView[] }) {
  return (
    <ol className="connected-agent__steps">
      {steps.map((step) => (
        <li data-state={step.state} key={step.id}>
          <span aria-hidden />
          {step.label}
          {step.state === "failed" ? (
            <span className="visually-hidden"> — {cloudWords("cloud.step.failed")}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * One work Home on the person's Cloud Computer screen: whose it is, where it stands,
 * what its organization decides, and nothing that pays for or powers it, which the
 * organization does.
 */
export function WorkHomeCards({ cards }: { readonly cards: readonly WorkHomeCard[] }) {
  return (
    <>
      {cards.map((card) => (
        <WorkHomeCardView card={card} key={card.assignmentId} />
      ))}
    </>
  );
}

function WorkHomeCardView({ card }: { readonly card: WorkHomeCard }) {
  const { deploymentAccess, desktopBridge, snapshot } = useShell();
  const here = card.deploymentId !== null && card.deploymentId === snapshot.deploymentId;
  const navigate = useNavigate();
  const listed =
    card.deploymentId === null
      ? null
      : (deploymentAccess?.deployments.find(({ id }) => id === card.deploymentId) ?? null);
  const open = () => {
    if (!desktopBridge) {
      if (card.address) window.open(card.address, "_blank", "noopener,noreferrer");
      return;
    }
    if (listed) void desktopBridge.select({ deploymentId: listed.id });
    void navigate("/");
  };
  const canOpen = card.address !== null && (desktopBridge ? listed !== null : true);
  const headingId = `work-home-${card.assignmentId}`;
  return (
    <section aria-labelledby={headingId} className="settings-group work-home">
      <h2 className="settings-group__title" id={headingId}>
        {card.title}
      </h2>
      <div className="card">
        <div className="card__row">
          <span aria-hidden className={`status-dot status-dot--${dotTone(card.status.tone)}`} />
          <span className="card__row-body">
            <span className="card__row-title">{card.status.label}</span>
            {card.status.reason ? (
              <span className="card__row-detail">{card.status.reason}</span>
            ) : null}
          </span>
          {card.address ? (
            <span className="card__row-actions">
              <button
                className="btn btn--small btn--primary"
                disabled={!canOpen}
                onClick={open}
                type="button"
              >
                {cloudWords("cloud.ready.open")}
              </button>
            </span>
          ) : null}
        </div>
        {card.steps ? (
          <div className="card__row">
            <SetupSteps steps={card.steps} />
          </div>
        ) : null}
        {card.address ? (
          <div className="card__form">
            <CopyBlock label={cloudWords("cloud.address")} value={card.address} />
          </div>
        ) : null}
        {card.lastBackup ? (
          <SettingsRow title={cloudWords("cloud.backup.reported")} detail={card.lastBackup} />
        ) : null}
        {card.region ? (
          <SettingsRow title={cloudWords("cloud.region")} detail={card.region} />
        ) : null}
        {card.browserAddress ? (
          <SettingsRow title={cloudWords("cloud.ip.address")} detail={card.browserAddress} />
        ) : null}
        <div className="card__row work-home__managed">
          <span aria-hidden className="card__row-glyph">
            <Icon name="users" />
          </span>
          <span className="card__row-body">
            <span className="card__row-title">{card.managed}</span>
          </span>
        </div>
      </div>
      <h3 className="settings-group__title work-home__subtitle">{card.policyTitle}</h3>
      <div className="card">
        {card.policy.map((line) => (
          <SettingsRow
            detail={line.detail}
            key={line.title}
            title={`${line.title}: ${line.value}`}
          />
        ))}
        {/* Read from inside the work Home: shown here only while it is the Home open. */}
        {here ? (
          <SettingsRow
            title={card.seeTitle}
            action={
              <Link className="btn btn--small" to={workHomeSeePath}>
                {orgWords("org.open")}
              </Link>
            }
          />
        ) : null}
      </div>
    </section>
  );
}

/** A work Home's row on its own Home page: the badge and "What {organization} can see". */
export function WorkHomeRow({ card }: { readonly card: WorkHomeCard }) {
  return (
    <SettingsGroup heading={null} headingId="device-home-work">
      <SettingsRow
        title={<WorkBadge card={card} />}
        detail={card.managed}
        action={
          <Link className="btn btn--small" to={workHomeSeePath}>
            {card.seeTitle}
          </Link>
        }
      />
    </SettingsGroup>
  );
}
