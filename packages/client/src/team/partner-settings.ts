import { OpensteerError } from "@opensteer/core";
import {
  parseTeamPartnerOffer,
  type HostApiCommandInput,
  type TeamPartnerInviteSchema,
  type TeamPartnerLink,
  type TeamSharingPolicy,
  type teamReadSchemas,
} from "@opensteer/protocol";
import type { z } from "zod";
import { PagedList } from "./paged-list.js";
import { teamRpcResult } from "./rpc-result.js";
import type { TeamSessionClient } from "./team-session-client.js";

export const sharingPolicyOptions: readonly {
  readonly value: TeamSharingPolicy;
  readonly label: string;
  readonly detail: string;
}[] = [
  {
    value: "off",
    label: "Off",
    detail: "No channels sync with partner teams while sharing is off.",
  },
  {
    value: "admins",
    label: "Admins only",
    detail: "Only admins can invite teams and approve sharing.",
  },
  {
    value: "members-propose",
    label: "Members propose, admins approve",
    detail: "Anyone can propose a partner team; admins on both teams approve it.",
  },
  {
    value: "members",
    label: "Members",
    detail: "Anyone can invite partner teams and approve sharing.",
  },
];

export function partnerLinkStatus(link: TeamPartnerLink): string {
  if (link.state === "revoked") return "Disconnected";
  if (!link.localApproved) return "Waiting for your approval";
  if (!link.partnerApproved) return "Waiting for their approval";
  return link.connected ? "Connected" : "Offline";
}

export function partnerLinkDetail(link: TeamPartnerLink): string | null {
  if (link.state === "revoked") return null;
  if (link.lastError === "identity-mismatch")
    return "This team’s identity changed. Disconnect and use a new invite to connect again.";
  if (link.lastError === "unsupported-partner-version")
    return "This partner team needs an Opensteer update.";
  return null;
}

export type PartnerInvite = z.infer<typeof TeamPartnerInviteSchema>;
export function partnerInviteStatus(invite: PartnerInvite, now = Date.now()): string {
  if (invite.revokedAt) return "Revoked";
  if (invite.consumedAt) return "Used";
  if (Date.parse(invite.expiresAt) <= now) return "Expired";
  return "Waiting to be used";
}

export function partnerActionError(error: unknown): string {
  if (error instanceof OpensteerError) {
    switch (error.reason) {
      case "partner-invite-expired":
        return "This invite expired. Ask the other team’s admin for a new one.";
      case "identity-mismatch":
        return "The team’s identity doesn’t match this invite. Ask its admin for a new one.";
      case "unsupported-partner-version":
        return "The partner team needs an Opensteer update before you can connect.";
      case "partner-refused":
      case "partner-disconnected":
      case "partner-revoked":
        return "The other team refused this invite. It may be used, revoked or expired, or sharing may be off. Ask its admin for a new invite.";
      case "partner-handshake-timeout":
        return "The partner team didn’t answer. Try again when it’s online.";
    }
    if (error.code === "not_found")
      return "Update this team’s Opensteer server to use partner teams.";
    if (error.code === "forbidden")
      return "Sharing may be turned off, or you may need an admin’s approval. Refresh and try again.";
  }
  return "The team didn’t answer. Check your connection and try again.";
}

type Policy = z.infer<(typeof teamReadSchemas)["team.sharing.policy.get"]["output"]>;
type Preview = z.infer<(typeof teamReadSchemas)["team.partner.invite.preview"]["output"]>;
type SettingsCommand = Extract<
  HostApiCommandInput,
  {
    type:
      | "team.partner.approve"
      | "team.partner.revoke"
      | "team.partner.invite.revoke"
      | "team.sharing.policy.set";
  }
>;
export interface PartnerSettingsState {
  readonly policy: Policy | null;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly pending: ReadonlySet<string>;
  readonly errors: Readonly<Record<string, string | null>>;
  readonly offerText: string;
  readonly preview: (Preview & { readonly offer: string }) | null;
  readonly created: { readonly invite: PartnerInvite; readonly offer: string } | null;
}

/** Kept only in this viewer's session; opening settings never adds work to team attachment. */
export class TeamPartnerSettings {
  readonly links: PagedList<TeamPartnerLink>;
  readonly invites: PagedList<PartnerInvite>;
  readonly #session: TeamSessionClient;
  readonly #listeners = new Set<() => void>();
  #refresh: Promise<void> | null = null;
  #previewGeneration = 0;
  #state: PartnerSettingsState = {
    policy: null,
    refreshing: false,
    error: null,
    pending: new Set(),
    errors: {},
    offerText: "",
    preview: null,
    created: null,
  };

  constructor(session: TeamSessionClient) {
    this.#session = session;
    this.links = new PagedList(async (after) => {
      const page = teamRpcResult(await session.rpc["team.partners.list"](after ? { after } : {}));
      return { items: page.links, nextCursor: page.nextCursor };
    });
    this.invites = new PagedList(async (after) => {
      const page = teamRpcResult(
        await session.rpc["team.partner.invites.list"](after ? { after } : {}),
      );
      return { items: page.invites, nextCursor: page.nextCursor };
    });
    session.signal.addEventListener(
      "abort",
      () => {
        this.#previewGeneration++;
        this.#state = { ...this.#state, policy: null, preview: null, created: null, offerText: "" };
        for (const listener of this.#listeners) listener();
      },
      { once: true },
    );
  }

  getSnapshot = (): PartnerSettingsState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(patch: Partial<PartnerSettingsState>) {
    if (this.#session.signal.aborted) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  refresh = (): Promise<void> => {
    if (this.#session.signal.aborted) return Promise.resolve();
    if (this.#refresh) return this.#refresh;
    this.#set({ refreshing: true, error: null });
    this.#refresh = Promise.all([
      this.#session.rpc["team.sharing.policy.get"]({})
        .then(teamRpcResult)
        .then(
          (policy) => this.#set({ policy }),
          (error: unknown) => this.#set({ error: partnerActionError(error) }),
        ),
      this.links.reload(),
      this.invites.reload(),
    ])
      .then(() => {
        const created = this.#state.created;
        const invite =
          created && this.invites.getState().items.find((row) => row.id === created.invite.id);
        if (created && invite) this.#set({ created: { ...created, invite } });
      })
      .finally(() => {
        this.#refresh = null;
        this.#set({ refreshing: false });
      });
    return this.#refresh;
  };

  async #run(key: string, work: () => Promise<void>, refresh = true): Promise<boolean> {
    if (this.#session.signal.aborted || this.#state.pending.has(key)) return false;
    this.#set({
      pending: new Set([...this.#state.pending, key]),
      errors: { ...this.#state.errors, [key]: null },
    });
    let done = false;
    try {
      await work();
      done = true;
    } catch (error) {
      this.#set({ errors: { ...this.#state.errors, [key]: partnerActionError(error) } });
    } finally {
      if (refresh) {
        await this.#refresh;
        await this.refresh();
      }
      const pending = new Set(this.#state.pending);
      pending.delete(key);
      this.#set({ pending });
    }
    return done && !this.#session.signal.aborted;
  }

  command = (key: string, command: SettingsCommand) =>
    this.#run(key, async () => {
      teamRpcResult(await this.#session.rpc["commands.dispatch"](command));
      if (
        command.type === "team.partner.invite.revoke" &&
        this.#state.created?.invite.id === command.inviteId
      )
        this.#set({ created: null });
    });

  createInvite = () =>
    this.#run("create", async () => {
      const result = teamRpcResult(
        await this.#session.rpc["commands.dispatch"]({ type: "team.partner.invite.create" }),
      );
      if (result.type === "team.partner.invite.create" && result.invite)
        this.#set({ created: { invite: result.invite, offer: result.offer } });
    });

  setOfferText = (offerText: string) => {
    this.#previewGeneration++;
    this.#set({
      offerText,
      preview: null,
      errors: { ...this.#state.errors, preview: null, redeem: null },
    });
  };

  previewInvite = () =>
    this.#run(
      "preview",
      async () => {
        const generation = this.#previewGeneration;
        const offer = this.#state.offerText.trim();
        try {
          parseTeamPartnerOffer(offer);
        } catch {
          this.#set({
            errors: {
              ...this.#state.errors,
              preview: "Paste the full partner invite link from the other team.",
            },
          });
          return;
        }
        let preview: Preview;
        try {
          preview = teamRpcResult(
            await this.#session.rpc["team.partner.invite.preview"]({ offer }),
          );
        } catch (error) {
          if (generation !== this.#previewGeneration) return;
          throw error;
        }
        if (generation === this.#previewGeneration) this.#set({ preview: { ...preview, offer } });
      },
      false,
    );

  redeemInvite = () =>
    this.#run("redeem", async () => {
      const preview = this.#state.preview;
      if (!preview) return;
      teamRpcResult(
        await this.#session.rpc["commands.dispatch"]({
          type: "team.partner.invite.redeem",
          offer: preview.offer,
        }),
      );
      if (this.#state.preview === preview) this.setOfferText("");
    });
}

const settings = new WeakMap<TeamSessionClient, TeamPartnerSettings>();
export function teamPartnerSettings(session: TeamSessionClient): TeamPartnerSettings {
  let held = settings.get(session);
  if (!held) {
    held = new TeamPartnerSettings(session);
    settings.set(session, held);
  }
  return held;
}
