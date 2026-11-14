import { createId, type TeamChannelId } from "@opensteer/core";
import type { HostApiCommandInput, TeamPartnerLink, teamReadSchemas } from "@opensteer/protocol";
import type { z } from "zod";
import { channelNameFromInput } from "./channels.js";
import { teamRpcResult } from "./rpc-result.js";
import type { TeamSessionClient } from "./team-session-client.js";

export type ChannelShare = z.infer<
  (typeof teamReadSchemas)["team.shares.list"]["output"]
>["shares"][number];
type Policy = z.infer<(typeof teamReadSchemas)["team.sharing.policy.get"]["output"]>;
type ShareCommand = Extract<
  HostApiCommandInput,
  { type: "team.share.offer" | "team.share.approve" | "team.share.accept" | "team.share.end" }
>;
export interface SharesState {
  readonly shares: readonly ChannelShare[];
  readonly links: readonly TeamPartnerLink[];
  readonly policy: Policy | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly pending: ReadonlySet<string>;
  readonly error: string | null;
  readonly errors: Readonly<Record<string, string | null>>;
}

export function channelShareStatus(share: ChannelShare): string {
  if (share.state === "ended") return "Disconnected";
  if (share.state === "active") return share.ready ? "Shared" : "Syncing history…";
  if (share.role === "follower") return "Incoming channel share";
  return share.localApproved ? "Waiting for their acceptance" : "Waiting for your team's approval";
}

function actionError(error: unknown): string {
  return error instanceof Error ? error.message : "The team didn't answer. Try again.";
}

export class TeamChannelShares {
  readonly #session: TeamSessionClient;
  readonly #channelId: TeamChannelId | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #acceptIds = new Map<string, TeamChannelId>();
  #refresh: Promise<void> | null = null;
  #state: SharesState = {
    shares: [],
    links: [],
    policy: null,
    loading: false,
    loaded: false,
    pending: new Set(),
    error: null,
    errors: {},
  };
  constructor(session: TeamSessionClient, channelId?: TeamChannelId) {
    this.#session = session;
    this.#channelId = channelId;
    session.signal.addEventListener(
      "abort",
      () => {
        this.#state = { ...this.#state, shares: [], links: [], policy: null };
        this.#emit();
      },
      { once: true },
    );
  }
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  #set(patch: Partial<SharesState>) {
    if (this.#session.signal.aborted) return;
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }
  refresh = (): Promise<void> => {
    if (this.#session.signal.aborted) return Promise.resolve();
    if (this.#refresh) return this.#refresh;
    this.#set({ loading: true, error: null });
    this.#refresh = this.#session.rpc["team.shares.list"](
      this.#channelId ? { channelId: this.#channelId } : {},
    )
      .then(teamRpcResult)
      .then(
        (page) => this.#set({ shares: page.shares, loaded: true }),
        (error: unknown) => this.#set({ error: actionError(error) }),
      )
      .finally(() => {
        this.#refresh = null;
        this.#set({ loading: false });
      });
    return this.#refresh;
  };
  loadPartners = async (): Promise<void> => {
    if (this.#session.signal.aborted) return;
    try {
      const policy = teamRpcResult(await this.#session.rpc["team.sharing.policy.get"]({}));
      if (this.#session.signal.aborted) return;
      const links: TeamPartnerLink[] = [];
      let after: string | undefined;
      do {
        const page = teamRpcResult(
          await this.#session.rpc["team.partners.list"](after ? { after } : {}),
        );
        if (this.#session.signal.aborted) return;
        links.push(...page.links);
        after = page.nextCursor ?? undefined;
      } while (after && links.length < 1000);
      this.#set({ policy, links: links.filter((link) => link.state === "active"), error: null });
    } catch (error) {
      this.#set({ error: actionError(error) });
    }
  };
  command = async (key: string, command: ShareCommand): Promise<boolean> => {
    if (this.#session.signal.aborted || this.#state.pending.has(key)) return false;
    this.#set({
      pending: new Set([...this.#state.pending, key]),
      errors: { ...this.#state.errors, [key]: null },
    });
    try {
      teamRpcResult(await this.#session.rpc["commands.dispatch"](command));
      await this.#refresh;
      await this.refresh();
      await this.#session
        .refreshSidebar()
        .catch((error: unknown) => this.#set({ error: actionError(error) }));
      return !this.#session.signal.aborted;
    } catch (error) {
      this.#set({ errors: { ...this.#state.errors, [key]: actionError(error) } });
      await this.refresh();
      return false;
    } finally {
      const pending = new Set(this.#state.pending);
      pending.delete(key);
      this.#set({ pending });
    }
  };
  accept = async (
    share: ChannelShare,
    name: string,
    kind: "public" | "private",
  ): Promise<TeamChannelId | null> => {
    const id = share.channelId ?? this.#acceptIds.get(share.id) ?? createId("teamChannel");
    this.#acceptIds.set(share.id, id);
    const done = await this.command(share.id, {
      type: "team.share.accept",
      shareId: share.id,
      id,
      name: channelNameFromInput(name),
      kind,
      peopleOnly: share.peopleOnly ?? false,
      access: [],
    });
    return done ? id : null;
  };
}

const models = new WeakMap<TeamSessionClient, Map<string, TeamChannelShares>>();
export function teamChannelShares(
  session: TeamSessionClient,
  channelId?: TeamChannelId,
): TeamChannelShares {
  let held = models.get(session);
  if (!held) {
    held = new Map();
    models.set(session, held);
  }
  const key = channelId ?? "all";
  let model = held.get(key);
  if (!model) {
    model = new TeamChannelShares(session, channelId);
    held.set(key, model);
  }
  return model;
}
