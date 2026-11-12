import { createHash } from "node:crypto";
import {
  OpensteerError,
  type DeploymentId,
  type TaskFolder,
  type TeamChannelId,
  type TeamTaskOrigin,
} from "@opensteer/core";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamChannelFoldersStore } from "@opensteer/database/personal-team-channel-folders-store";
import { parseTeamLinkOffer, type PersonalTeamLink } from "@opensteer/protocol";
import { type TeamLinkRpc, linkError } from "../team-link-endpoint/contracts.js";
import { TeamLinkConnection } from "./connection.js";
import { verifiedTeamDiscovery } from "./discovery.js";
import { TeamLinkNetwork } from "./network.js";
import { PersonalTeamVault } from "./vault.js";
import { PersonalTeamRequests } from "./requests.js";

export interface PersonalTeamLinksOptions {
  readonly deploymentId: DeploymentId;
  readonly installationLabel: string;
  readonly links: PersonalTeamLinksStore;
  readonly folders: PersonalTeamChannelFoldersStore;
  readonly vault: PersonalTeamVault;
  readonly network: Pick<TeamLinkNetwork, "discover" | "redeem" | "connect">;
  readonly requests: PersonalTeamRequests;
  readonly admitFolder: (folder: TaskFolder) => Promise<TaskFolder>;
}

export class PersonalTeamLinks {
  readonly options: PersonalTeamLinksOptions;
  readonly #connections = new Map<DeploymentId, TeamLinkConnection>();
  readonly #operations = new Map<DeploymentId, Promise<unknown>>();
  readonly #lifetime = new AbortController();
  readonly #leaveRetries = new Map<DeploymentId, ReturnType<typeof setTimeout>>();
  constructor(options: PersonalTeamLinksOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    for (const link of await this.options.links.list()) {
      if (link.state === "leaving") this.#retryLeave(link.teamDeploymentId);
      else if (["active", "unreachable", "needs_update"].includes(link.state))
        this.#connect(link.teamDeploymentId);
    }
  }

  async stop(): Promise<void> {
    this.#lifetime.abort();
    for (const timer of this.#leaveRetries.values()) clearTimeout(timer);
    this.#leaveRetries.clear();
    for (const connection of this.#connections.values()) connection.stop();
    this.#connections.clear();
    await Promise.allSettled(this.#operations.values());
  }

  #serialize<Value>(teamId: DeploymentId, action: () => Promise<Value>): Promise<Value> {
    const previous = this.#operations.get(teamId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.#operations.set(teamId, next);
    void next
      .finally(() => {
        if (this.#operations.get(teamId) === next) this.#operations.delete(teamId);
      })
      .catch(() => undefined);
    return next;
  }

  async join(text: string): Promise<PersonalTeamLink> {
    const offer = parseTeamLinkOffer(text);
    if (!offer) throw linkError("bad_request");
    return this.#serialize(offer.teamId, async () => {
      const { links, network, vault } = this.options;
      const existing = await links.get(offer.teamId);
      if (
        existing &&
        (existing.hostKeyFingerprint !== offer.hostKeyFingerprint ||
          existing.approvedOrigin !== offer.origin)
      )
        throw linkError();
      const descriptor = verifiedTeamDiscovery(
        await network.discover(offer.origin, this.#lifetime.signal),
        offer,
        existing?.teamHostInstanceId,
      );
      let secret: string;
      const saved = existing?.credentialReference
        ? await vault.open(existing.credentialReference, offer.teamId)
        : null;
      if (
        saved?.offer.code === offer.code &&
        existing &&
        !["revoked", "leaving"].includes(existing.state)
      ) {
        secret = saved.secret;
      } else {
        this.#connections.get(offer.teamId)?.stop();
        this.#connections.delete(offer.teamId);
        const prepared = await vault.prepare(offer);
        secret = prepared.secret;
        await links.begin(
          {
            teamDeploymentId: offer.teamId,
            teamHostInstanceId: descriptor.authority.document.hostInstanceId,
            hostKeyFingerprint: offer.hostKeyFingerprint,
            approvedOrigin: offer.origin,
            authorityEnvelope: {
              authority: descriptor.authority,
              teamName: new URL(offer.origin).hostname.slice(0, 160),
            },
            credentialReference: prepared.credential.id,
            remoteLinkId: null,
            remoteOwnerUserId: null,
            state: "joining",
            lastContactAt: null,
          },
          prepared.credential,
        );
      }
      const remote = await network.redeem(
        offer.origin,
        {
          code: offer.code,
          credentialHash: createHash("sha256").update(secret).digest("hex"),
          personalDeploymentId: this.options.deploymentId,
          installationLabel: this.options.installationLabel,
        },
        this.#lifetime.signal,
      );
      if (remote.state !== "active" || remote.personalDeploymentId !== this.options.deploymentId)
        throw linkError();
      if (existing?.remoteLinkId !== remote.id) {
        for (const request of await this.options.requests.options.requests.forTeam(offer.teamId))
          await this.options.requests.cancel(offer.teamId, request.requestId);
      }
      await links.observeName(offer.teamId, remote.teamName);
      await links.active(offer.teamId, remote);
      if (existing?.state === "needs_update") {
        this.#connections.get(offer.teamId)?.stop();
        this.#connections.delete(offer.teamId);
      }
      this.#connect(offer.teamId);
      return links.view((await links.get(offer.teamId))!);
    });
  }

  #connect(teamId: DeploymentId): void {
    if (this.#connections.has(teamId) || this.#lifetime.signal.aborted) return;
    const { links, vault, network, requests } = this.options;
    const connection = new TeamLinkConnection({
      teamId,
      open: async (signal) => {
        const link = await links.get(teamId);
        if (!link?.credentialReference || ["leaving", "revoked"].includes(link.state))
          throw linkError("unauthorized");
        const { secret, offer } = await vault.open(link.credentialReference, teamId);
        verifiedTeamDiscovery(
          await network.discover(link.approvedOrigin, signal),
          offer,
          link.teamHostInstanceId,
        );
        return network.connect(link.approvedOrigin, secret, signal);
      },
      terminalRequests: () => requests.options.requests.forTeam(teamId),
      onReady: () => requests.reconnect(teamId),
      onFrame: async (frame) => {
        if (frame.type === "requests") {
          for (const item of frame.requests) await requests.deliver(teamId, item);
        } else if (frame.type === "cancel") await requests.cancel(teamId, frame.requestId);
        else await requests.revoked(teamId);
      },
      onState: async (state, error) => {
        const current = await links.get(teamId);
        if (current && !["leaving", "revoked"].includes(current.state)) {
          if (
            state === "needs_update" &&
            (error?.details?.behind === "personal" || error?.details?.behind === "team")
          )
            await links.versionMismatch(teamId, error.details.behind);
          else if (state === "active" && current.remoteLinkId && current.remoteOwnerUserId)
            await links.active(teamId, {
              id: current.remoteLinkId,
              ownerUserId: current.remoteOwnerUserId,
            });
          else await links.state(teamId, state);
        }
      },
    });
    this.#connections.set(teamId, connection);
    connection.start();
  }

  rpc(teamId: DeploymentId): TeamLinkRpc {
    const connection = this.#connections.get(teamId);
    if (!connection) throw linkError("runner_offline");
    return {
      call: async (input) => {
        const link = await this.options.links.get(teamId);
        if (link?.state === "needs_update" || link?.state === "joining")
          throw linkError("runner_offline");
        if (!link || !["active", "unreachable"].includes(link.state)) throw linkError();
        return connection.call(input);
      },
    };
  }

  async leave(teamId: DeploymentId): Promise<void> {
    // Dispatch closes before waiting for either another operation or the remote server.
    await this.options.links.state(teamId, "leaving");
    this.#connections.get(teamId)?.stop();
    this.#connections.delete(teamId);
    for (const request of await this.options.requests.options.requests.forTeam(teamId))
      await this.options.requests.cancel(teamId, request.requestId);
    this.#retryLeave(teamId);
  }

  #retryLeave(teamId: DeploymentId, attempt = 0): void {
    if (this.#lifetime.signal.aborted || this.#leaveRetries.has(teamId)) return;
    const timer = setTimeout(
      () => {
        this.#leaveRetries.delete(teamId);
        void this.#serialize(teamId, async () => {
          const link = await this.options.links.get(teamId);
          if (link?.state !== "leaving" || !link.credentialReference) return;
          const { secret, offer } = await this.options.vault.open(link.credentialReference, teamId);
          verifiedTeamDiscovery(
            await this.options.network.discover(link.approvedOrigin, this.#lifetime.signal),
            offer,
            link.teamHostInstanceId,
          );
          await this.#revokeOnly(link.approvedOrigin, secret);
          await this.options.links.state(teamId, "revoked");
        }).catch(() => this.#retryLeave(teamId, attempt + 1));
      },
      attempt === 0
        ? 0
        : Math.floor(
            Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random() * 0.5),
          ),
    );
    timer.unref();
    this.#leaveRetries.set(teamId, timer);
  }

  async #revokeOnly(origin: string, secret: string): Promise<void> {
    let connection: TeamLinkConnection | undefined;
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const current = new TeamLinkConnection({
          teamId: this.options.deploymentId,
          open: (signal) => this.options.network.connect(origin, secret, signal),
          terminalRequests: async () => [],
          onFrame: async (frame) => {
            if (frame.type === "revoked") resolve();
          },
          onState: async (state) => {
            if (state !== "active") reject(linkError("runner_offline"));
          },
          onReady: async () => {
            try {
              await current.call({ type: "revoke" });
              resolve();
            } catch (error) {
              if (error instanceof OpensteerError && error.code === "unauthorized") resolve();
              else reject(error);
            }
          },
        });
        connection = current;
        abort = () => reject(linkError("runner_offline"));
        this.#lifetime.signal.addEventListener("abort", abort, { once: true });
        if (this.#lifetime.signal.aborted) abort();
        else current.start();
      });
    } finally {
      connection?.stop();
      if (abort) this.#lifetime.signal.removeEventListener("abort", abort);
    }
  }

  async list(): Promise<PersonalTeamLink[]> {
    return (await this.options.links.list()).map((link) => this.options.links.view(link));
  }
  folder(teamId: DeploymentId, channelId: TeamChannelId) {
    return this.options.folders.get(teamId, channelId);
  }
  async setFolder(
    teamId: DeploymentId,
    channelId: TeamChannelId,
    folder: TaskFolder,
  ): Promise<void> {
    await this.options.folders.set(teamId, channelId, await this.options.admitFolder(folder));
  }
  task(origin: TeamTaskOrigin) {
    return this.options.folders.task(origin);
  }
}
