import { randomBytes, randomUUID } from "node:crypto";
import { OpensteerError, type TeamActor } from "@opensteer/core";
import {
  parseTeamPartnerOffer,
  TeamPartnerHelloSchema,
  TeamPartnerChallengeSchema,
  TeamPartnerProofSchema,
  TeamPartnerReadySchema,
  TeamPartnerControlSchema,
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
}
export interface TeamPartnerNetwork {
  discover(origin: string, signal: AbortSignal): Promise<unknown>;
  connectSocket(origin: string, path: string, signal: AbortSignal): Promise<WebSocket>;
}

export class TeamPartners {
  readonly #entries = new Set<Entry>();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #opening = new Map<string, Promise<void>>();
  readonly #retry = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #attempts = new Map<string, number>();
  readonly #abort = new AbortController();
  readonly #network: TeamPartnerNetwork;

  readonly options: {
    store: TeamPartnerStore;
    keys: Pick<HostKeyPair, "privateKey">;
    teamName: string;
    network?: TeamPartnerNetwork;
    publicOnly: () => Promise<boolean>;
    onError: () => void;
  };
  constructor(options: TeamPartners["options"]) {
    this.options = options;
    this.#network = options.network ?? new TeamLinkNetwork(options.publicOnly);
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
    const row = await this.store.propose(
      actor,
      descriptor.authority,
      new URL(offer.origin).hostname.slice(0, 160),
    );
    await this.store.access.outsideHumanSession(() => this.#open(row, offer));
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
    const entry: Entry = { peer: new PartnerSocket(socket), active: false };
    this.#entries.add(entry);
    void entry.peer.closed.then(() => this.#entries.delete(entry));
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
    entry.id = existing?.id ?? randomUUID();
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
      row = await this.store.accept(
        hello.selector,
        proof.verifier,
        hello.authority,
        hello.name,
        hello.approved,
        entry.id,
      );
    } else {
      if (proof.verifier || !existing) throw partnerError();
      row = await this.store.seen(existing.id, hello.approved);
    }
    entry.id = row.id;
    entry.active = row.state === "active";
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
            await this.store.revoke(row.id);
            throw partnerError("partner-revoked");
          }
          const current = await this.store.seen(row.id, ready.approved, response.name);
          if (current.state === "revoked") throw partnerError();
          entry.active = current.state === "active";
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
      this.#schedule(row.id);
      throw error;
    }
  }

  async #receive(entry: Entry, row: PartnerRow) {
    for (;;) {
      const frame = TeamPartnerControlSchema.parse(await entry.peer.next());
      if (frame.type === "revoked") {
        await this.store.revoke(row.id);
        await this.#closeLink(row.id);
        return;
      }
      // Approvals take effect only in the next fresh, mutually authenticated handshake.
      if (frame.type === "approval") {
        await entry.peer.close();
        return;
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
        await this.#open(row);
      } catch (error) {
        const reason =
          error instanceof OpensteerError &&
          (error.reason === "identity-mismatch" || error.reason === "unsupported-partner-version")
            ? error.reason
            : "unreachable";
        await this.store.failed(id, reason);
        if (reason !== "identity-mismatch") this.#schedule(id);
        else this.#cancelRetry(id);
      }
    });
    this.#opening.set(id, job);
    this.#track(job.finally(() => this.#opening.delete(id)));
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
  async close() {
    this.#abort.abort();
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
