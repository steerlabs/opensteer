import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTeamChannelShares } from "@opensteer/client/react";
import {
  channelShareStatus,
  shareHistoryWarning,
  shareOfferUnavailable,
  type ChannelShare,
  type TeamSessionClient,
} from "@opensteer/client/team";
import type { TeamChannelSummary } from "@opensteer/protocol";
import { Dialog } from "../components/dialog.js";
import { channelPath } from "./team-paths.js";

export function ChannelShares({
  client,
  channel,
}: {
  readonly client: TeamSessionClient;
  readonly channel?: TeamChannelSummary;
}) {
  const { model, state } = useTeamChannelShares(client, channel?.id);
  const [offering, setOffering] = useState(false);
  const [partnerId, setPartnerId] = useState("");
  const [accepting, setAccepting] = useState<ChannelShare | null>(null);
  const [ending, setEnding] = useState<ChannelShare | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const refresh = () => {
      void model.refresh();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [model]);
  const teamId = client.scope.teamDeploymentId;
  const blocked = channel
    ? shareOfferUnavailable(channel, client.getSnapshot().bootstrap?.generalChannelId)
    : null;
  const partner = state.links.find((link) => link.id === partnerId);
  const error = (key: string) =>
    state.errors[key] ? <p role="alert">{state.errors[key]}</p> : null;
  const shares = state.shares.filter((share) => channel || share.state === "offered");
  return (
    <section className="details-block" aria-label="Shared channels">
      <h3 className="details-block__title">{channel ? "Partner team" : "Channel share offers"}</h3>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button
        className="btn btn--small btn--ghost"
        disabled={state.loading}
        onClick={() => void model.refresh()}
        type="button"
      >
        {state.loading ? "Refreshing…" : "Refresh offers"}
      </button>
      {state.loaded && shares.length === 0 && !state.nextCursor && !channel ? (
        <p className="details-note">No pending channel shares.</p>
      ) : null}
      {shares.map((share) => (
        <div className="partner-settings-form" key={share.id}>
          <p>
            <b>#{share.name}</b> · {share.partnerName}
          </p>
          <p className="details-note">{channelShareStatus(share)}</p>
          {share.canApprove === undefined && share.state !== "ended" ? (
            <p className="details-note">
              Update this team's Opensteer server to manage channel shares.
            </p>
          ) : null}
          <div className="partner-settings-actions">
            {share.canApprove ? (
              <button
                className="btn btn--small"
                disabled={state.pending.has(share.id)}
                onClick={() =>
                  void model.command(share.id, { type: "team.share.approve", shareId: share.id })
                }
                type="button"
              >
                Approve share
              </button>
            ) : null}
            {share.canAccept ? (
              <button
                className="btn btn--small"
                disabled={state.pending.has(share.id)}
                onClick={() => setAccepting(share)}
                type="button"
              >
                Review share
              </button>
            ) : null}
            {share.canEnd ? (
              <button
                className="btn btn--small btn--danger"
                disabled={state.pending.has(share.id)}
                onClick={() => setEnding(share)}
                type="button"
              >
                {share.state === "offered"
                  ? share.role === "follower"
                    ? "Decline"
                    : "Cancel offer"
                  : "Disconnect channel"}
              </button>
            ) : null}
          </div>
          {error(share.id)}
        </div>
      ))}
      {state.nextCursor ? (
        <button
          className="btn btn--small"
          disabled={state.loading || state.loadingMore}
          onClick={() => void model.more()}
          type="button"
        >
          {state.loadingMore ? "Loading…" : "Show more shares"}
        </button>
      ) : null}
      {state.loaded &&
      channel?.can.manage &&
      !blocked &&
      !shares.some((share) => share.state !== "ended") ? (
        <button
          className="btn btn--small"
          onClick={() => {
            setOffering(true);
            void model.loadPartners();
          }}
          type="button"
        >
          Share with a partner team
        </button>
      ) : null}
      {blocked && channel?.can.manage ? <p className="details-note">{blocked}</p> : null}
      {offering && channel ? (
        <Dialog
          title={`Share #${channel.name}`}
          labelledBy="channel-share-title"
          onClose={() => setOffering(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setOffering(false)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={
                  !partner || state.policy?.canPropose !== true || state.pending.has("offer")
                }
                onClick={() => {
                  if (partner)
                    void model
                      .command("offer", {
                        type: "team.share.offer",
                        channelId: channel.id,
                        linkId: partner.id,
                        historyVisibleConfirmed: true,
                      })
                      .then((done) => {
                        if (done) setOffering(false);
                      });
                }}
                type="button"
              >
                {state.pending.has("offer") ? "Offering…" : "Share channel"}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field__label">Partner team</span>
            <select value={partnerId} onChange={(event) => setPartnerId(event.currentTarget.value)}>
              <option value="">Choose a team</option>
              {state.links.map((link) => (
                <option key={link.id} value={link.id}>
                  {link.partnerName}
                </option>
              ))}
            </select>
          </label>
          {state.policy && state.links.length === 0 ? (
            <p>
              No linked partner teams.{" "}
              <Link to={`/settings/teams/${encodeURIComponent(teamId)}/partners`}>
                Open Partner teams settings
              </Link>
            </p>
          ) : null}
          {state.policy && !state.policy.canPropose ? (
            <p>Sharing is turned off or requires an admin.</p>
          ) : null}
          {partner ? <p>{shareHistoryWarning(channel.name, partner.partnerName)}</p> : null}
          {error("offer")}
        </Dialog>
      ) : null}
      {accepting ? (
        <AcceptShare
          share={accepting}
          busy={state.pending.has(accepting.id)}
          error={state.errors[accepting.id] ?? null}
          onClose={() => setAccepting(null)}
          onAccept={(name, kind) => {
            void model.accept(accepting, name, kind).then((id) => {
              if (id) {
                setAccepting(null);
                void navigate(channelPath(teamId, id));
              }
            });
          }}
        />
      ) : null}
      {ending ? (
        <Dialog
          title={`${ending.state === "offered" ? (ending.role === "follower" ? "Decline" : "Cancel offer to") : "Disconnect from"} ${ending.partnerName}?`}
          labelledBy="channel-end-share"
          onClose={() => setEnding(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setEnding(null)} type="button">
                Keep sharing
              </button>
              <button
                className="btn btn--danger"
                disabled={state.pending.has(ending.id)}
                onClick={() =>
                  void model
                    .command(ending.id, { type: "team.share.end", shareId: ending.id })
                    .then((done) => {
                      if (done) setEnding(null);
                    })
                }
                type="button"
              >
                Confirm
              </button>
            </>
          }
        >
          <p>
            {ending.role === "follower"
              ? "Your copy becomes a read-only archive. You can still read its history."
              : "Your channel continues with your team. The other team keeps its received history."}
          </p>
          {error(ending.id)}
        </Dialog>
      ) : null}
    </section>
  );
}

function AcceptShare({
  share,
  busy,
  error,
  onClose,
  onAccept,
}: {
  readonly share: ChannelShare;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onAccept: (name: string, kind: "public" | "private") => void;
}) {
  const [name, setName] = useState(share.name);
  const [kind, setKind] = useState<"public" | "private">("private");
  return (
    <Dialog
      title={`Accept a channel from ${share.partnerName}?`}
      labelledBy="channel-accept-share"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !name.trim()}
            onClick={() => onAccept(name, kind)}
            type="button"
          >
            {busy ? "Accepting…" : "Accept share"}
          </button>
        </>
      }
    >
      <p>
        Both teams see this channel's history, members' names and photos. Each team manages its own
        people.
      </p>
      {share.historyFromShareId ? (
        <p>This creates a new channel. Your previous archive stays separate.</p>
      ) : null}
      <label className="field">
        <span className="field__label">Channel name on your team</span>
        <input
          maxLength={160}
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
      </label>
      <label className="field">
        <span className="field__label">Access on your team</span>
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.currentTarget.value === "public" ? "public" : "private")
          }
        >
          <option value="private">Private · only you to start; add your people later</option>
          <option value="public">Public · anyone on your team can join</option>
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
    </Dialog>
  );
}
