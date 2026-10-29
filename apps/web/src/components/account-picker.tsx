import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import {
  accountFunding,
  observedAccountConnection,
  placementAccountDetail,
  placementAccountTitle,
  type AccountFunding,
  type ThreadPlacementOption,
  type UsageModelScope,
} from "@opensteer/client/host";
import { composerFold } from "./fold-to-fit.js";
import { Icon, type IconName } from "./icon.js";
import { Popover } from "./popover.js";
import { UsageMeter } from "./usage-meter.js";

/**
 * How an account is paid for, drawn before its name: a person for a plan they
 * signed in with, a key for pay-as-you-go, a cloud for a cloud identity, a
 * server for a model server. An account that never said how it pays wears the
 * person, the most common case, rather than a mark that claims something.
 */
const fundingGlyph: Record<AccountFunding, IconName> = {
  cloud: "cloud",
  key: "key",
  plan: "user",
  server: "server",
};

export function AccountGlyph({
  placement,
}: {
  readonly placement: Pick<ThreadPlacementOption, "observedConnections" | "source">;
}) {
  const funding = accountFunding(placement);
  return <Icon name={funding ? fundingGlyph[funding] : "user"} />;
}

/** Signing an account in, or asking again whether it is signed in outside Opensteer. */
export interface AccountFixes {
  readonly onAuthenticate?: ((placement: ThreadPlacementOption) => void) | undefined;
  readonly onRefresh?: ((placement: ThreadPlacementOption) => Promise<void>) | undefined;
}

/**
 * The one action that can make an unavailable account usable from here, or
 * null when nothing here can: a managed sign-in when the engine offers one,
 * otherwise "Check again" for a sign-in done outside Opensteer.
 */
export function AccountFix({
  onAuthenticate,
  onRefresh,
  placement,
}: AccountFixes & { readonly placement: ThreadPlacementOption }) {
  const [checking, setChecking] = useState(false);
  if (
    placement.availability !== "authentication-required" ||
    !placement.harnessAuthenticationAllowed
  )
    return null;
  if (placement.setupAvailable && onAuthenticate) {
    return (
      <button
        className="btn btn--small picker__setup"
        onClick={() => onAuthenticate(placement)}
        type="button"
      >
        Sign in
      </button>
    );
  }
  if (!onRefresh) return null;
  return (
    <button
      className="btn btn--small picker__setup"
      disabled={checking}
      onClick={() => {
        setChecking(true);
        void onRefresh(placement).finally(() => setChecking(false));
      }}
      type="button"
    >
      {checking ? "Checking…" : "Check again"}
    </button>
  );
}

/**
 * One account as a row: how it pays, who it signs in as, and — when it can run
 * — its plan and what is left of it, or why it cannot. The press is the
 * caller's: the account pill applies the account, the engine menu shows its
 * models.
 */
export function AccountRow({
  disabled = false,
  inUse,
  model,
  onPress,
  placement,
  showWhere,
  viewing = false,
  ...fixes
}: AccountFixes & {
  /** Pressing it can do nothing here; the row still says why, and offers its fix. */
  readonly disabled?: boolean;
  readonly inUse: boolean;
  /** The model in play, so a plan window scoped to another model says nothing here. */
  readonly model?: UsageModelScope | undefined;
  readonly onPress: () => void;
  readonly placement: ThreadPlacementOption;
  readonly showWhere: boolean;
  readonly viewing?: boolean;
}) {
  const detailId = useId();
  const title = placementAccountTitle(placement);
  const connection = observedAccountConnection(placement.observedConnections);
  const detail = placement.available
    ? [
        showWhere ? placement.whereLabel : null,
        placementAccountDetail(placement, Date.now(), model),
      ]
        .filter(Boolean)
        .join(" · ")
    : placement.detail;
  const classes = [
    "picker__row",
    placement.available ? "" : "picker__row--off",
    viewing ? "is-viewing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="picker__item">
      <button
        aria-checked={inUse}
        aria-describedby={detail ? detailId : undefined}
        // Not `disabled`: a disabled button cannot take focus, and the reason
        // it is unusable is the one thing the row has to say.
        aria-disabled={disabled || undefined}
        aria-label={title}
        className={classes}
        onClick={onPress}
        role="menuitemradio"
        type="button"
      >
        <span className="picker__check">{inUse ? <Icon name="check" /> : null}</span>
        <span className="picker__glyph">
          <AccountGlyph placement={placement} />
        </span>
        <span className="picker__label-stack">
          <span className="picker__label">
            {title}
            {placement.defaultAccount ? <span className="picker__tag">Default</span> : null}
          </span>
          {detail ? (
            <span className="picker__detail picker__detail--wrap" id={detailId}>
              {detail}
            </span>
          ) : null}
          {placement.available && connection && placement.source?.quota === "windows" ? (
            <UsageMeter connection={connection} {...(model ? { model } : {})} />
          ) : null}
        </span>
      </button>
      <AccountFix placement={placement} {...fixes} />
    </div>
  );
}

interface AccountPickerProps extends AccountFixes {
  /** Every account of the engine in play that the composer may run on, available or not. */
  accounts: readonly ThreadPlacementOption[];
  current: ThreadPlacementOption;
  disabled?: boolean;
  model: UsageModelScope;
  onSelect: (placement: ThreadPlacementOption) => void;
}

/**
 * The composer's account pill: which account of the engine in play pays for
 * the work, named by who it signs in as and marked by how it pays. It exists
 * only while the engine has more than one account to choose from. Choosing
 * another keeps the model when that account offers it.
 *
 * A narrow composer folds the whole pill away rather than shrinking it to a
 * mark: no mark says which of one person's accounts is in play, and the model
 * menu lists the same accounts, so nothing becomes unreachable.
 */
export function AccountPicker({
  accounts,
  current,
  disabled,
  model,
  onSelect,
  ...fixes
}: AccountPickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const title = placementAccountTitle(current);
  const detail = placementAccountDetail(current, Date.now(), model);
  const showWhere = new Set(accounts.map((account) => account.environmentId)).size > 1;
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${title}`}
        className="exec-pill"
        data-fold={composerFold.account}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        ref={anchorRef}
        title={[title, detail].filter(Boolean).join("\n")}
        type="button"
      >
        <AccountGlyph placement={current} />
        <span className="exec-pill__label">{title}</span>
        <Icon className="exec-pill__chevron" name="chevron-down" />
      </button>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="popover--accounts"
          label={`${current.engineName} accounts`}
          onClose={() => setOpen(false)}
        >
          <div
            aria-label={`${current.engineName} accounts`}
            className="picker__section"
            role="group"
          >
            <span className="picker__heading">{current.engineName} accounts</span>
            {accounts.map((account) => (
              <AccountRow
                disabled={!account.available}
                inUse={account.harnessInstanceId === current.harnessInstanceId}
                key={account.harnessInstanceId}
                model={model}
                onPress={() => {
                  if (!account.available) return;
                  setOpen(false);
                  onSelect(account);
                }}
                placement={account}
                showWhere={showWhere}
                {...fixes}
              />
            ))}
            <ManageAccountsLink environmentId={current.environmentId} />
          </div>
        </Popover>
      ) : null}
    </>
  );
}

export function ManageAccountsLink({ environmentId }: { readonly environmentId: string }) {
  return (
    <Link
      className="picker__manage"
      to={`/settings/ai-engines?location=${encodeURIComponent(environmentId)}`}
    >
      Manage accounts
      <Icon name="chevron-right" />
    </Link>
  );
}
