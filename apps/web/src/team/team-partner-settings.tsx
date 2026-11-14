import { ChannelShares } from "./channel-shares.js";
import { useEffect, useState } from "react";
import { useTeamPartnerSettings } from "@opensteer/client/react";
import {
  partnerActionError,
  partnerInviteStatus,
  partnerLinkDetail,
  partnerLinkStatus,
  sharingPolicyOptions,
  type TeamSessionClient,
} from "@opensteer/client/team";
import type { TeamPartnerLink } from "@opensteer/protocol";
import { copyText } from "@opensteer/shared/clipboard";
import { Dialog } from "../components/dialog.js";
import {
  SettingsError,
  SettingsGroup,
  SettingsRow,
  formatWhen,
} from "../components/settings/primitives.js";

export function TeamPartnerSettingsPage({ client }: { readonly client: TeamSessionClient }) {
  const { model, state, links, invites } = useTeamPartnerSettings(client);
  const [disconnect, setDisconnect] = useState<TeamPartnerLink | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  useEffect(() => {
    const focus = () => {
      void model.refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [model]);
  const error = (key: string) => <SettingsError message={state.errors[key] ?? null} />;
  const policy = state.policy;
  const created = state.created;
  const rows = invites.items.filter((invite) => invite.id !== created?.invite.id);
  const copy = async (offer: string) => {
    const success = await copyText(offer);
    if (client.signal.aborted) return;
    setCopied(success ? offer : null);
    setHandoffError(success ? null : "Select the link to copy it.");
  };
  return (
    <>
      <ChannelShares client={client} />
      <p className="settings-footnote">
        Connect another team, then choose which channels to share with it.
      </p>
      <SettingsError message={state.error} />
      {policy && policy.canPropose === undefined ? (
        <SettingsError message="Update this team’s Opensteer server to manage partner teams." />
      ) : null}
      <button
        className="btn btn--small"
        disabled={state.refreshing}
        onClick={() => void model.refresh()}
        type="button"
      >
        {state.refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <SettingsGroup heading="Sharing policy" headingId="partner-policy">
        {policy ? (
          sharingPolicyOptions
            .filter((option) => policy.canSet || policy.policy === option.value)
            .map((option) => (
              <SettingsRow
                action={
                  policy.canSet ? (
                    <input
                      aria-label={option.label}
                      checked={policy.policy === option.value}
                      disabled={state.pending.has("policy")}
                      name="sharing-policy"
                      onChange={() =>
                        void model.command("policy", {
                          type: "team.sharing.policy.set",
                          policy: option.value,
                        })
                      }
                      type="radio"
                    />
                  ) : undefined
                }
                detail={option.detail}
                key={option.value}
                title={option.label}
              />
            ))
        ) : (
          <SettingsRow title="Loading sharing policy…" />
        )}
      </SettingsGroup>
      {error("policy")}
      <SettingsGroup heading="Linked teams" headingId="partner-links">
        {links.first === null && !links.error ? (
          <SettingsRow title="Loading partner teams…" />
        ) : null}
        {links.first !== null && links.items.length === 0 ? (
          <SettingsRow title="No partner teams yet" />
        ) : null}
        {links.items.map((link) => (
          <div className="partner-settings-entry" key={link.id}>
            <SettingsRow
              action={
                <>
                  {link.canApprove ? (
                    <button
                      className="btn btn--small"
                      disabled={state.pending.has(link.id)}
                      onClick={() =>
                        void model.command(link.id, {
                          type: "team.partner.approve",
                          linkId: link.id,
                        })
                      }
                      type="button"
                    >
                      {state.pending.has(link.id) ? "Approving…" : "Approve"}
                    </button>
                  ) : null}
                  {link.canRevoke ? (
                    <button
                      className="btn btn--danger btn--small"
                      disabled={state.pending.has(link.id)}
                      onClick={() => setDisconnect(link)}
                      type="button"
                    >
                      Disconnect
                    </button>
                  ) : null}
                </>
              }
              detail={
                <>
                  {link.partnerOrigin}
                  <br />
                  {partnerLinkStatus(link)} ·{" "}
                  {link.lastSeenAt ? `Last seen ${formatWhen(link.lastSeenAt)}` : "Not seen yet"}
                  {partnerLinkDetail(link) ? (
                    <>
                      <br />
                      {partnerLinkDetail(link)}
                    </>
                  ) : null}
                </>
              }
              title={link.partnerName}
            />
            {error(link.id)}
          </div>
        ))}
      </SettingsGroup>
      <SettingsError message={links.error ? partnerActionError(links.error) : null} />
      {links.nextCursor ? (
        <button
          className="btn btn--small"
          disabled={links.loadingMore}
          onClick={() => void model.links.more()}
          type="button"
        >
          {links.loadingMore ? "Loading…" : "Show more teams"}
        </button>
      ) : null}
      <SettingsGroup
        heading="Invite a team"
        headingId="partner-invite"
        note="Send the link to an admin of the other team. Each invite works once. Keep a copy if you’ll need it later."
      >
        {policy?.canPropose ? (
          <SettingsRow
            action={
              <button
                className="btn btn--small"
                disabled={state.pending.has("create")}
                onClick={() => void model.createInvite()}
                type="button"
              >
                {state.pending.has("create") ? "Creating…" : "Create invite"}
              </button>
            }
            title="Invite a partner team"
          />
        ) : (
          <SettingsRow
            title={
              policy?.policy === "off"
                ? "Sharing is turned off"
                : "Ask an admin to invite a partner team"
            }
          />
        )}
        {created ? (
          <div className="partner-settings-form">
            <label className="field__label" htmlFor="partner-invite-link">
              Partner invite link
            </label>
            <input id="partner-invite-link" readOnly value={created.offer} />
            <p className="settings-footnote">
              {partnerInviteStatus(created.invite)} · Expires {formatWhen(created.invite.expiresAt)}
            </p>
            <div className="partner-settings-actions">
              <button
                className="btn btn--small"
                onClick={() => void copy(created.offer)}
                type="button"
              >
                {copied === created.offer ? "Copied" : "Copy"}
              </button>
              <button
                className="btn btn--small"
                onClick={() => {
                  if (typeof navigator.share !== "function") {
                    void copy(created.offer);
                    return;
                  }
                  void navigator
                    .share({ title: "Partner team invite", text: created.offer })
                    .catch((reason: unknown) => {
                      if (
                        !client.signal.aborted &&
                        !(reason instanceof Error && reason.name === "AbortError")
                      )
                        setHandoffError("Sharing didn’t open. Copy the link instead.");
                    });
                }}
                type="button"
              >
                Share
              </button>
              {created.invite.canRevoke ? (
                <button
                  className="btn btn--danger btn--small"
                  disabled={state.pending.has(created.invite.id)}
                  onClick={() =>
                    void model.command(created.invite.id, {
                      type: "team.partner.invite.revoke",
                      inviteId: created.invite.id,
                    })
                  }
                  type="button"
                >
                  {state.pending.has(created.invite.id) ? "Revoking…" : "Revoke"}
                </button>
              ) : null}
            </div>
            {error(created.invite.id)}
          </div>
        ) : null}
        {rows.map((invite) => (
          <div className="partner-settings-entry" key={invite.id}>
            <SettingsRow
              action={
                invite.canRevoke ? (
                  <button
                    className="btn btn--danger btn--small"
                    disabled={state.pending.has(invite.id)}
                    onClick={() =>
                      void model.command(invite.id, {
                        type: "team.partner.invite.revoke",
                        inviteId: invite.id,
                      })
                    }
                    type="button"
                  >
                    {state.pending.has(invite.id) ? "Revoking…" : "Revoke"}
                  </button>
                ) : undefined
              }
              detail={`Created ${formatWhen(invite.createdAt)} · Expires ${formatWhen(invite.expiresAt)}`}
              title={partnerInviteStatus(invite)}
            />
            {error(invite.id)}
          </div>
        ))}
      </SettingsGroup>
      {error("create")}
      <SettingsError
        message={handoffError ?? (invites.error ? partnerActionError(invites.error) : null)}
      />
      {invites.nextCursor ? (
        <button
          className="btn btn--small"
          disabled={invites.loadingMore}
          onClick={() => void model.invites.more()}
          type="button"
        >
          {invites.loadingMore ? "Loading…" : "Show more invites"}
        </button>
      ) : null}
      {policy?.canPropose ? (
        <SettingsGroup heading="Use an invite" headingId="partner-redeem">
          <form
            className="partner-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void model.previewInvite();
            }}
          >
            <label className="field__label" htmlFor="partner-offer">
              Partner invite link
            </label>
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={state.pending.has("redeem")}
              id="partner-offer"
              maxLength={4096}
              onChange={(event) => model.setOfferText(event.currentTarget.value)}
              placeholder="Paste the other team’s invite"
              spellCheck={false}
              value={state.offerText}
            />
            <button
              className="btn btn--small"
              disabled={
                !state.offerText.trim() ||
                state.pending.has("preview") ||
                state.pending.has("redeem")
              }
              type="submit"
            >
              {state.pending.has("preview") ? "Checking…" : "Check invite"}
            </button>
            {error("preview")}
          </form>
          {state.preview ? (
            <SettingsRow
              action={
                <>
                  <button
                    className="btn btn--ghost btn--small"
                    disabled={state.pending.has("redeem")}
                    onClick={() => model.setOfferText("")}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn--small"
                    disabled={state.pending.has("redeem")}
                    onClick={() => void model.redeemInvite()}
                    type="button"
                  >
                    {state.pending.has("redeem") ? "Connecting…" : "Connect team"}
                  </button>
                </>
              }
              detail={
                <>
                  {state.preview.origin}
                  <br />
                  Expires {formatWhen(state.preview.expiresAt)}. Only channels you share with this
                  team will sync.
                </>
              }
              title={`Connect to ${state.preview.name}?`}
            />
          ) : null}
          {error("redeem")}
        </SettingsGroup>
      ) : null}
      {disconnect ? (
        <Dialog
          labelledBy="partner-disconnect-title"
          onClose={() => setDisconnect(null)}
          title={`Disconnect ${disconnect.partnerName}?`}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDisconnect(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={state.pending.has(disconnect.id)}
                onClick={() => {
                  void model
                    .command(disconnect.id, { type: "team.partner.revoke", linkId: disconnect.id })
                    .then((done) => {
                      if (done) setDisconnect(null);
                    });
                }}
                type="button"
              >
                {state.pending.has(disconnect.id) ? "Disconnecting…" : "Disconnect"}
              </button>
            </>
          }
        >
          <p>Channels shared with this team stop syncing. Their history stays on both teams.</p>
          {error(disconnect.id)}
        </Dialog>
      ) : null}
    </>
  );
}
