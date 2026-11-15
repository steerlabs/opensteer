import { z } from "zod";
import { sql } from "kysely";
import type { TeamBus } from "@opensteer/database/team-bus";
import type { TeamPartnerOfferVault } from "./offer-vault.js";
import { PartnerMailbox, partnerCallError } from "./mailbox.js";
import { randomBytes, randomUUID } from "node:crypto";
import { OpensteerError, type TeamActor } from "@opensteer/core";
import {
  TeamPartnerFrameViewSchema,
  TeamShareOperationSchema,
  type TeamShareOperation,
  parseTeamPartnerOffer,
  TeamPartnerHelloSchema,
  TeamPartnerChallengeSchema,
  TeamPartnerProofSchema,
  TeamPartnerReadySchema,
  readTeamFrame,
  teamPartnerProtocolVersion,
  teamPartnerSocketPath,
  type TeamPartnerOffer,
  type TeamPartnerChallenge,
  type TeamSharingPolicy,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { WebSocket } from "ws";
import type { HostKeyPair } from "../identity/host-keys.js";
import { TeamLinkNetwork } from "../team-links/network.js";
import { TeamPartnerStore, type PartnerRow } from "./store.js";
import { PartnerSocket } from "./socket.js";
import { TeamLinkLifetimes } from "../team-link-endpoint/lifetimes.js";
import {
  partnerError,
  signPartnerChallenge,
  verifiedPartnerAuthority,
  verifiedPartnerDescriptor,
  verifyPartnerChallenge,
  verifyPartnerPins,
} from "./identity.js";

interface Entry {
  readonly peer: PartnerSocket;
  teamId?: string;
  id?: string;
  active: boolean;
  approvals?: string;
  incoming: number;
}
export interface TeamPartnerNetwork {
  discover(origin: string, signal: AbortSignal): Promise<unknown>;
  connectSocket(origin: string, path: string, signal: AbortSignal): Promise<WebSocket>;
}

interface PartnerDataHandler {
  receive(linkId: string, operation: TeamShareOperation): Promise<unknown>;
  reply(linkId: string, operation: TeamShareOperation, send: () => Promise<void>): Promise<void>;
  changed(linkId: string, shareId: string, generation: number): Promise<void>;
  connected(linkId: string): Promise<void>;
  revoked(linkId: string): Promise<void>;
}
export class TeamPartners {
  readonly lifetimes = new TeamLinkLifetimes();
  readonly #unsubscribeAccess: () => void;
  readonly #entries = new Set<Entry>();
  readonly #pending = new Map<
    string,
    { entry: Entry; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #data: PartnerDataHandler | undefined;
  setDataHandler(handler: PartnerDataHandler) {
    this.#data = handler;
  }

  async request(
    linkId: string,
    operation: TeamShareOperation,
    signal?: AbortSignal,
    handoff: (send: () => Promise<void>) => Promise<void> = (send) => send(),
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const combined = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;
    const fence = async (send: () => Promise<void>) => {
      const revision = await this.store.access.current();
      const authorize = () => this.#authorize(linkId, operation);
      await authorize();
      await this.store.access.handoff(revision, authorize, send);
    };
    const result = this.connected(linkId)
      ? await this.#localRequest(linkId, operation, combined, (send) => handoff(() => fence(send)))
      : this.#mailbox
        ? await this.#mailbox.request(linkId, operation, combined, (send) =>
            handoff(() => fence(send)),
          )
        : await Promise.reject(partnerError("partner-unreachable"));
    await handoff(() => fence(async () => {}));
    return result;
  }

  async #localRequest(
    linkId: string,
    operation: TeamShareOperation,
    signal: AbortSignal,
    handoff: (send: () => Promise<void>) => Promise<void>,
  ): Promise<unknown> {
    const entry = [...this.#entries].find(
      (e) => e.id === linkId && e.active && e.peer.socket.readyState === 1,
    );
    if (
      !entry ||
      this.#pending.size >= 256 ||
      [...this.#pending.values()].filter((p) => p.entry === entry).length >= 32
    )
      throw partnerError("partner-unreachable");
    const id = randomUUID();
    const controller = new AbortController();
    const pendingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await withTimeout(
        new Promise<unknown>((resolve, reject) => {
          this.#pending.set(id, { entry, resolve, reject });
          void handoff(() => {
            pendingSignal.throwIfAborted();
            return entry.peer.send({ type: "share.request", id, operation });
          }).catch(reject);
        }),
        5000,
        { signal: pendingSignal, timeoutError: () => partnerError("partner-unreachable") },
      );
    } finally {
      controller.abort();
      this.#pending.delete(id);
    }
  }
  async hint(linkId: string, shareId: string, generation: number) {
    await Promise.all(
      [...this.#entries]
        .filter((e) => e.id === linkId && e.active)
        .map((e) => e.peer.send({ type: "share.changed", shareId, generation })),
    );
  }
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #opening = new Map<string, Promise<void>>();
  readonly #retry = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #attempts = new Map<string, number>();
  readonly #mailbox: PartnerMailbox | undefined;
  readonly #unsubscribeBus: (() => void)[] = [];
  readonly #draining = new Map<string, Promise<void>>();
  readonly #drainAgain = new Set<string>();
  readonly #abort = new AbortController();
  readonly #network: TeamPartnerNetwork;

  readonly options: {
    bus?: TeamBus;
    processId?: string;
    offerVault?: TeamPartnerOfferVault;
    store: TeamPartnerStore;
    keys: Pick<HostKeyPair, "privateKey">;
    teamName: string;
    network?: TeamPartnerNetwork;
    publicOnly: () => Promise<boolean>;
    onError: () => void;
  };
  constructor(options: TeamPartners["options"]) {
    this.options = options;
    if (options.bus) {
      if (!options.processId) throw new Error("Partner mailbox requires processId");
      this.#mailbox = new PartnerMailbox(options.store, options.bus, options.processId);
      this.#unsubscribeBus.push(
        options.bus.on((event) => {
          if (event.kind === "partnerCall") this.#track(this.#drain(event.linkId));
          if (event.kind === "partnerLink") this.#track(this.#linkChanged(event.linkId));
        }),
        options.bus.onResync(() => this.#resync()),
      );
    }
    this.#network = options.network ?? new TeamLinkNetwork(options.publicOnly);
    this.#unsubscribeAccess = this.store.access.onRevoke((effects) =>
      this.lifetimes.close(effects),
    );
  }

  get store() {
    return this.options.store;
  }
  get authority() {
    return this.store.authority;
  }
  connected = (id: string) =>
    [...this.#entries].some(
      (entry) => entry.id === id && entry.active && entry.peer.socket.readyState === 1,
    );

  async #authorize(linkId: string, operation: TeamShareOperation) {
    // A partner chooses the share id; one that cannot exist must not reach a uuid column.
    if (!z.uuid().safeParse(operation.shareId).success) throw partnerError("not-found");
    return this.store.access.database.transaction().execute(async (t) => {
      const row = await this.store.get(linkId, t);
      if (!row || row.state !== "active" || (await this.store.policy(t)) === "off")
        throw partnerError("not-found");
      const share = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", operation.shareId)
        .where("partnerLinkId", "=", linkId)
        .executeTakeFirst();
      if (
        !share ||
        (share.generation !== operation.generation &&
          !(
            operation.op === "end" &&
            share.state === "ended" &&
            share.generation === operation.generation + 1
          )) ||
        (share.state === "ended" && operation.op !== "end") ||
        (share.state === "offered" && !["offer", "accept", "roster", "end"].includes(operation.op))
      )
        throw partnerError("not-found");
      return true;
    });
  }

  async #offer(id: string) {
    const row = await this.store.get(id);
    if (!row?.sealedOffer) return undefined;
    if (!this.options.offerVault) throw new Error("Partner pairing requires offerVault");
    return this.options.offerVault.open(id, row.sealedOffer);
  }
  async #clearOffer(id: string) {
    await this.store.access.database
      .updateTable("teamPartnerLinks")
      .set({ sealedOffer: null })
      .where("id", "=", id)
      .execute();
  }
  maintenance() {
    return this.#mailbox?.maintenance() ?? Promise.resolve();
  }

  async #linkChanged(id: string) {
    const row = await this.store.get(id);
    const off = await this.store.access.database
      .transaction()
      .execute(async (t) => (await this.store.policy(t)) === "off");
    if (!row || row.state === "revoked" || off) {
      this.#cancelRetry(id);
      await this.#closeLink(id, row?.state === "revoked" ? { type: "revoked" } : undefined);
      if (row?.state === "revoked") await this.#data?.revoked(id);
      return;
    }
    // An opening handshake already reads the committed approval state.
    if (
      [...this.#entries].some(
        (entry) =>
          entry.id === id &&
          entry.approvals !== undefined &&
          entry.approvals !== JSON.stringify([row.localApproved, row.partnerApproved]),
      )
    )
      await this.#closeLink(id, { type: "approval" });
    if (row.role === "dialer") this.reconnect(id);
    await this.#drain(id);
  }
  async #resync() {
    const rows = await this.store.access.database
      .selectFrom("teamPartnerLinks")
      .select("id")
      .execute();
    await Promise.all(rows.map((row) => this.#linkChanged(row.id)));
  }
  #drain(linkId: string): Promise<void> {
    const running = this.#draining.get(linkId);
    if (running) {
      this.#drainAgain.add(linkId);
      return running;
    }
    const job = (async () => {
      if (!this.#mailbox || !this.connected(linkId) || this.#abort.signal.aborted) return;
      for (;;) {
        this.#drainAgain.delete(linkId);
        const rows = await this.#mailbox.claim(linkId);
        if (!rows.length) {
          if (this.#drainAgain.has(linkId)) continue;
          return;
        }
        await Promise.all(
          rows.map(async (row) => {
            let result: unknown = null,
              error: unknown = null;
            try {
              const operation = TeamShareOperationSchema.parse(row.operation);
              const revision = await this.store.access.current();
              const authorize = () => this.#authorize(linkId, operation);
              await authorize();
              result = await this.#localRequest(
                linkId,
                operation,
                AbortSignal.any([
                  this.#abort.signal,
                  AbortSignal.timeout(Math.max(1, row.expiresAt.getTime() - Date.now())),
                ]),
                async (send) =>
                  await this.store.access.handoff(revision, authorize, async () => {
                    await authorize();
                    await send();
                  }),
              );
            } catch (caught) {
              error = partnerCallError(caught);
            }
            await this.store.access.database
              .updateTable("teamPartnerCalls")
              .set({
                state: error ? "failed" : "done",
                result: sql`${JSON.stringify(result ?? null)}::jsonb`,
                error: sql`${JSON.stringify(error)}::jsonb`,
              })
              .where("id", "=", row.id)
              .where("state", "=", "claimed")
              .where("claimedBy", "=", this.options.processId!)
              .execute();
          }),
        );
        if (!this.connected(linkId) || this.#abort.signal.aborted) return;
      }
    })().finally(() => {
      this.#draining.delete(linkId);
      this.#drainAgain.delete(linkId);
    });
    this.#draining.set(linkId, job);
    return job;
  }

  async start() {
    for (const row of await this.store.access.database
      .selectFrom("teamPartnerLinks")
      .selectAll()
      .where("role", "=", "dialer")
      .where("state", "!=", "revoked")
      .execute())
      this.reconnect(row.id);
  }

  async redeem(actor: TeamActor, text: string) {
    const offer = parseTeamPartnerOffer(text);
    if (Date.parse(offer.expiresAt) <= Date.now()) throw partnerError();
    // Check local authority before even probing an address supplied in an invite.
    await this.store.write((t) => this.store.authorize(t, actor, "propose"));
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]);
    const descriptor = verifiedPartnerDescriptor(
      await this.#network.discover(offer.origin, signal),
      offer,
    );
    if (!this.options.offerVault) throw new Error("Partner pairing requires offerVault");
    // Claimed inside the proposal's own transaction: its notification can arrive before this
    // call resumes, and `reconnect` must not start a second handshake for the same invite.
    const handshake = Promise.withResolvers<void>();
    let claimed: string | undefined;
    let row: Awaited<ReturnType<TeamPartnerStore["propose"]>>;
    try {
      row = await this.store.propose(
        actor,
        descriptor.authority,
        new URL(offer.origin).hostname.slice(0, 160),
        (id) => {
          if (claimed) this.#opening.delete(claimed);
          claimed = id;
          this.#opening.set(id, handshake.promise);
          return this.options.offerVault!.seal(id, offer);
        },
      );
    } catch (error) {
      if (claimed) this.#opening.delete(claimed);
      handshake.resolve();
      throw error;
    }
    try {
      await this.store.access.outsideHumanSession(() => this.#open(row, offer));
    } catch (error) {
      this.#opening.delete(row.id);
      handshake.resolve();
      await this.store.access.outsideHumanSession(() => this.#failed(row.id, error));
      throw error;
    }
    this.#opening.delete(row.id);
    handshake.resolve();
    const result = await this.store.list(actor, this.connected, { id: row.id });
    const link = result.links.find((r) => r.id === row.id);
    if (!link) throw partnerError();
    return { link };
  }

  async preview(actor: TeamActor, text: string) {
    const offer = parseTeamPartnerOffer(text);
    if (Date.parse(offer.expiresAt) <= Date.now()) throw partnerError("partner-invite-expired");
    await this.store.access.database
      .transaction()
      .execute((t) => this.store.authorize(t, actor, "propose"));
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]);
    verifiedPartnerDescriptor(await this.#network.discover(offer.origin, signal), offer);
    const peer = new PartnerSocket(
      await this.#network.connectSocket(offer.origin, teamPartnerSocketPath, signal),
    );
    try {
      return await withTimeout(
        (async () => {
          const nonce = randomBytes(32).toString("base64url");
          await peer.send({
            type: "hello",
            version: teamPartnerProtocolVersion,
            authority: this.authority,
            name: this.options.teamName,
            nonce,
            approved: false,
            selector: offer.selector,
          });
          const response = TeamPartnerChallengeSchema.parse(await peer.next());
          verifyPartnerPins(response.authority, offer);
          verifyPartnerChallenge(
            response.authority,
            {
              purpose: "pair",
              selector: offer.selector,
              listenerTeamId: offer.teamId,
              dialerTeamId: this.authority.document.deploymentId,
              listenerNonce: response.nonce,
              dialerNonce: nonce,
              listenerApproved: response.approved,
              dialerApproved: false,
              version: teamPartnerProtocolVersion,
            },
            "listener",
            response.signature,
          );
          // No proof or verifier is sent: preview cannot consume an invite or create a link.
          return { name: response.name, origin: offer.origin, expiresAt: offer.expiresAt };
        })(),
        10_000,
        { signal, timeoutError: () => partnerError("partner-handshake-timeout") },
      );
    } finally {
      await peer.close();
    }
  }

  async approve(actor: TeamActor, id: string) {
    await this.store.approve(actor, id);
    const row = await this.store.get(id);
    if (!row) throw partnerError();
    await this.#closeLink(id, { type: "approval" });
    if (row.role === "dialer") this.reconnect(id);
  }

  async revoke(actor: TeamActor, id: string) {
    await this.store.revoke(id, actor);
    await this.#clearOffer(id);
    await this.#data?.revoked(id);
    const row = await this.store.get(id);
    if (row) await this.#closeLink(id, { type: "revoked" });
    this.#cancelRetry(id);
  }

  async setPolicy(actor: TeamActor, policy: TeamSharingPolicy) {
    await this.store.setPolicy(actor, policy);
    if (policy === "off") {
      for (const id of this.#retry.keys()) this.#cancelRetry(id);
      await Promise.all([...this.#entries].map((entry) => entry.peer.close()));
    } else await this.start();
  }

  accept(socket: WebSocket) {
    if (this.#abort.signal.aborted || this.#entries.size >= 128) {
      socket.terminate();
      return;
    }
    const entry = this.#entry(socket);
    this.#track(
      this.store.access.outsideHumanSession(async () => {
        try {
          const row = await withTimeout(this.#listen(entry), 10_000, {
            timeoutError: () => partnerError("partner-handshake-timeout"),
          });
          await this.#receive(entry, row);
        } catch {
          await entry.peer.close();
        }
      }),
    );
  }

  #entry(socket: WebSocket) {
    const entry: Entry = { peer: new PartnerSocket(socket), active: false, incoming: 0 };
    this.#entries.add(entry);
    void entry.peer.closed.then(() => {
      this.#entries.delete(entry);
      for (const pending of this.#pending.values())
        if (pending.entry === entry) pending.reject(partnerError("partner-unreachable"));
    });
    return entry;
  }

  async #listen(entry: Entry) {
    const hello = TeamPartnerHelloSchema.parse(await entry.peer.next());
    if (hello.version !== teamPartnerProtocolVersion)
      throw partnerError("unsupported-partner-version");
    verifiedPartnerAuthority(hello.authority);
    entry.teamId = hello.authority.document.deploymentId;
    if (entry.teamId === this.authority.document.deploymentId) throw partnerError();
    const existing = hello.selector
      ? undefined
      : await this.store.find(hello.authority.document.deploymentId);
    if (!hello.selector && (!existing || existing.role !== "listener")) throw partnerError();
    entry.id = existing?.id ?? hello.selector ?? randomUUID();
    if (existing) {
      verifyPartnerPins(hello.authority, pins(existing));
      entry.id = existing.id;
    }
    const policy = await this.store.access.database
      .transaction()
      .execute((t) => this.store.policy(t));
    if (policy === "off") throw partnerError();
    const approved = existing?.localApproved ?? policy === "members";
    const nonce = randomBytes(32).toString("base64url");
    const challenge: TeamPartnerChallenge = {
      purpose: hello.selector ? "pair" : "connect",
      ...(hello.selector ? { selector: hello.selector } : {}),
      listenerTeamId: this.authority.document.deploymentId,
      dialerTeamId: hello.authority.document.deploymentId,
      listenerNonce: nonce,
      dialerNonce: hello.nonce,
      listenerApproved: approved,
      dialerApproved: hello.approved,
      version: hello.version,
    };
    await entry.peer.send({
      type: "challenge",
      name: this.options.teamName,
      authority: this.authority,
      nonce,
      approved,
      signature: signPartnerChallenge(this.options.keys.privateKey, challenge, "listener"),
    });
    const proof = TeamPartnerProofSchema.parse(await entry.peer.next());
    verifyPartnerChallenge(hello.authority, challenge, "dialer", proof.signature);
    let row: PartnerRow;
    if (hello.selector) {
      if (!proof.verifier) throw partnerError();
      try {
        row = await this.store.accept(
          hello.selector,
          proof.verifier,
          hello.authority,
          hello.name,
          hello.approved,
        );
      } catch (error) {
        if (error instanceof OpensteerError && error.code === "forbidden")
          await entry.peer.send({ type: "ready", state: "revoked", approved: false });
        throw error;
      }
    } else {
      if (proof.verifier || !existing) throw partnerError();
      row = await this.store.seen(existing.id, hello.approved);
    }
    entry.id = row.id;
    entry.active = row.state === "active";
    entry.approvals = JSON.stringify([row.localApproved, row.partnerApproved]);
    await entry.peer.send({ type: "ready", state: row.state, approved: row.localApproved });
    if (row.state === "revoked") {
      await entry.peer.close();
      throw partnerError();
    }
    return row;
  }

  async #open(row: PartnerRow, offer?: TeamPartnerOffer) {
    if (this.#abort.signal.aborted) throw partnerError();
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]);
    const descriptor = verifiedPartnerDescriptor(
      await this.#network.discover(row.partnerOrigin, signal),
      pins(row),
    );
    const socket = await this.#network.connectSocket(
      row.partnerOrigin,
      teamPartnerSocketPath,
      this.#abort.signal,
    );
    const entry = this.#entry(socket);
    entry.id = row.id;
    entry.teamId = row.partnerTeamId;
    try {
      await withTimeout(
        (async () => {
          // Registration precedes the access fence so revoke cannot miss an opening socket.
          const fresh = await this.store.seen(row.id, row.partnerApproved);
          if (fresh.state === "revoked") throw partnerError();
          const nonce = randomBytes(32).toString("base64url");
          await entry.peer.send({
            type: "hello",
            version: teamPartnerProtocolVersion,
            authority: this.authority,
            name: this.options.teamName,
            nonce,
            approved: fresh.localApproved,
            ...(offer ? { selector: offer.selector } : {}),
          });
          const response = TeamPartnerChallengeSchema.parse(await entry.peer.next());
          verifyPartnerPins(response.authority, pins(row));
          if (response.authority.publicKey.spki !== descriptor.authority.publicKey.spki)
            throw partnerError("identity-mismatch");
          const challenge: TeamPartnerChallenge = {
            purpose: offer ? "pair" : "connect",
            ...(offer ? { selector: offer.selector } : {}),
            listenerTeamId: row.partnerTeamId,
            dialerTeamId: this.authority.document.deploymentId,
            listenerNonce: response.nonce,
            dialerNonce: nonce,
            listenerApproved: response.approved,
            dialerApproved: fresh.localApproved,
            version: teamPartnerProtocolVersion,
          };
          verifyPartnerChallenge(response.authority, challenge, "listener", response.signature);
          await entry.peer.send({
            type: "proof",
            signature: signPartnerChallenge(this.options.keys.privateKey, challenge, "dialer"),
            ...(offer ? { verifier: offer.verifier } : {}),
          });
          const ready = TeamPartnerReadySchema.parse(await entry.peer.next());
          if (ready.state === "revoked") {
            if (offer) throw partnerError("partner-pairing-refused");
            await this.store.revoke(row.id);
            throw partnerError("partner-revoked");
          }
          const current = await this.store.seen(row.id, ready.approved, response.name);
          if (current.state === "revoked") throw partnerError();
          entry.active = current.state === "active";
          entry.approvals = JSON.stringify([current.localApproved, current.partnerApproved]);
          await this.#clearOffer(row.id);
          this.#attempts.delete(row.id);
        })(),
        10_000,
        { timeoutError: () => partnerError("partner-handshake-timeout") },
      );
      this.#track(
        this.#receive(entry, row)
          .catch(async () => {
            await entry.peer.close();
          })
          .finally(() => this.#schedule(row.id)),
      );
    } catch (error) {
      await entry.peer.close();
      throw error;
    }
  }

  async #receive(entry: Entry, row: PartnerRow) {
    if (entry.active) this.#track(this.#drain(row.id));
    if (entry.active && this.#data)
      this.#track(
        this.#data.connected(row.id).catch(async (error: unknown) => {
          this.options.onError();
          if (!(
            error instanceof OpensteerError && error.reason === "shared-channel-update-required"
          ))
            await entry.peer.close();
        }),
      );
    for (;;) {
      // A newer partner may send frame types this server does not know yet.
      const frame = readTeamFrame(TeamPartnerFrameViewSchema, await entry.peer.next());
      if (!frame) continue;
      if (frame.type === "revoked") {
        await this.store.revoke(row.id);
        await this.#data?.revoked(row.id);
        await this.#closeLink(row.id);
        return;
      }
      // Approvals take effect only in the next fresh, mutually authenticated handshake.
      if (frame.type === "approval") {
        await entry.peer.close();
        return;
      }
      if (!entry.active || !this.#data) throw partnerError();
      if (frame.type === "share.response") {
        const pending = this.#pending.get(frame.id);
        if (pending?.entry === entry) {
          if (frame.ok) pending.resolve(frame.result);
          else
            pending.reject(
              frame.reason === "retryable"
                ? new OpensteerError({
                    code: "resource_exhausted",
                    reason: "partner-retry-later",
                    retryable: true,
                    message: "Shared channel is temporarily limited",
                    details: { retryAfterMs: frame.retryAfterMs ?? 1000 },
                  })
                : partnerError(frame.reason ?? "not-found"),
            );
        }
      } else if (frame.type === "share.changed") {
        if (entry.incoming >= 32) throw partnerError();
        entry.incoming++;
        this.#track(
          this.#data
            .changed(row.id, frame.shareId, frame.generation)
            .finally(() => entry.incoming--),
        );
      } else {
        if (entry.incoming >= 32) throw partnerError();
        const operation = TeamShareOperationSchema.safeParse(frame.operation);
        if (!operation.success) {
          // Requests are strict, and every refusal looks alike so a partner learns nothing.
          await entry.peer.send({
            type: "share.response",
            id: frame.id,
            ok: false,
            reason: "not-found",
          });
          continue;
        }
        const handler = this.#data;
        entry.incoming++;
        this.#track(
          handler
            .receive(row.id, operation.data)
            .then((result) =>
              handler.reply(row.id, operation.data, () =>
                entry.peer.send({ type: "share.response", id: frame.id, ok: true, result }),
              ),
            )
            .catch((error: unknown) =>
              entry.peer.send({
                type: "share.response",
                id: frame.id,
                ok: false,
                reason:
                  error instanceof OpensteerError && error.retryable ? "retryable" : "not-found",
                ...(error instanceof OpensteerError &&
                typeof error.details?.retryAfterMs === "number"
                  ? { retryAfterMs: error.details.retryAfterMs }
                  : {}),
              }),
            )
            .finally(() => entry.incoming--),
        );
      }
    }
  }

  reconnect(id: string) {
    this.#cancelRetry(id);
    if (
      this.#abort.signal.aborted ||
      this.#opening.has(id) ||
      [...this.#entries].some((entry) => entry.id === id && entry.peer.socket.readyState === 1)
    )
      return;
    const job = this.store.access.outsideHumanSession(async () => {
      try {
        const row = await this.store.get(id);
        if (
          !row ||
          row.state === "revoked" ||
          row.role !== "dialer" ||
          row.lastError === "identity-mismatch"
        )
          return;
        const policy = await this.store.access.database
          .transaction()
          .execute((t) => this.store.policy(t));
        if (policy === "off") return;
        const offer = await this.#offer(id);
        if (offer && Date.parse(offer.expiresAt) <= Date.now())
          throw partnerError("partner-invite-expired");
        await this.#open(row, offer);
      } catch (error) {
        await this.#failed(id, error);
      }
    });
    this.#opening.set(id, job);
    this.#track(job.finally(() => this.#opening.delete(id)));
  }

  async #failed(id: string, error: unknown) {
    const offer = await this.#offer(id);
    if (
      offer &&
      (Date.parse(offer.expiresAt) <= Date.now() ||
        (error instanceof OpensteerError &&
          (error.reason === "partner-pairing-refused" || error.reason === "identity-mismatch")))
    ) {
      await this.#clearOffer(id);
      this.#cancelRetry(id);
      await this.store.abandonProposal(id);
      return;
    }
    const reason =
      error instanceof OpensteerError &&
      (error.reason === "identity-mismatch" || error.reason === "unsupported-partner-version")
        ? error.reason
        : "unreachable";
    await this.store.failed(id, reason);
    if (reason !== "identity-mismatch") this.#schedule(id);
    else this.#cancelRetry(id);
  }

  #schedule(id: string) {
    if (this.#abort.signal.aborted || this.#retry.has(id)) return;
    const attempt = this.#attempts.get(id) ?? 0;
    this.#attempts.set(id, attempt + 1);
    const timer = setTimeout(
      () => {
        this.#retry.delete(id);
        this.reconnect(id);
      },
      Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)),
    );
    timer.unref();
    this.#retry.set(id, timer);
  }
  #cancelRetry(id: string) {
    const timer = this.#retry.get(id);
    if (timer) clearTimeout(timer);
    this.#retry.delete(id);
  }
  async #closeLink(id: string, frame?: unknown) {
    await Promise.all(
      [...this.#entries].filter((entry) => entry.id === id).map((entry) => entry.peer.close(frame)),
    );
  }
  #track(job: Promise<unknown>) {
    this.#jobs.add(job);
    void job.catch(() => this.options.onError()).finally(() => this.#jobs.delete(job));
  }
  /** Drops every partner socket; dialer links reconnect on their own. */
  async closeSockets() {
    await Promise.all([...this.#entries].map((entry) => entry.peer.close()));
  }
  async close() {
    this.#unsubscribeAccess();
    this.lifetimes.stop();
    this.#abort.abort();
    this.#mailbox?.close();
    for (const unsubscribe of this.#unsubscribeBus) unsubscribe();
    for (const id of this.#retry.keys()) this.#cancelRetry(id);
    await Promise.all([...this.#entries].map((entry) => entry.peer.close()));
    await Promise.allSettled(this.#jobs);
  }
}

function pins(row: PartnerRow) {
  return {
    teamId: row.partnerTeamId,
    origin: row.partnerOrigin,
    hostKeyFingerprint: row.partnerHostKeyFingerprint,
    hostInstanceId: row.partnerHostInstanceId,
  };
}
