import {
  WorkAuditFlushClaimsSchema,
  WorkAuditFlushRequestSchema,
  WorkAuditPushSchema,
  WorkPolicyChangedClaimsSchema,
  WorkPolicyClaimsSchema,
  WorkPolicyDocumentSchema,
  workAuditFlushPath,
  workAuditSigningBytes,
  workPolicyChangedPath,
  type WorkAssignmentId,
} from "@opensteer/control-plane-protocol";
import { OpensteerError, type DeploymentId } from "@opensteer/core";
import type { WorkHomeStore } from "@opensteer/database";
import type { FastifyInstance } from "fastify";
import { sign, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AccountDirectoryClient } from "../access/account-directory-client.js";
import { AccountJwksVerifier } from "../access/account-jwks-verifier.js";
import { unversionedRoute } from "../server/unversioned-route.js";

interface WorkHomeOptions {
  readonly issuer: URL;
  readonly origin: string;
  readonly assignmentId: WorkAssignmentId;
  readonly deploymentId: DeploymentId;
  readonly account: () => Promise<Pick<
    AccountDirectoryClient,
    "workPolicy" | "reportWorkPolicy" | "pushWorkAudit"
  > | null>;
  readonly store: WorkHomeStore;
  readonly key: KeyObject;
  readonly jwksFetch?: typeof globalThis.fetch;
  readonly onApplied: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}

export class WorkHomeService {
  readonly #options: WorkHomeOptions;
  readonly #verifier: AccountJwksVerifier;
  readonly #lifetime = new AbortController();
  #policyPass: Promise<void> | undefined;
  #auditPass: Promise<"empty" | "sent" | "unavailable"> | undefined;
  #reportedRevision = 0;
  #refreshRequested = false;

  constructor(options: WorkHomeOptions) {
    this.#options = options;
    this.#verifier = new AccountJwksVerifier({
      issuer: options.issuer,
      ...(options.jwksFetch ? { fetch: options.jwksFetch } : {}),
    });
  }

  start(): void {
    this.wake();
    void this.flush(this.#lifetime.signal).catch(this.#options.onError);
  }

  close(): void {
    this.#lifetime.abort();
  }

  wake(): void {
    this.#refreshRequested = true;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.#policyPass) return this.#policyPass;
    this.#refreshRequested = true;
    this.#policyPass = this.#refresh().finally(() => {
      this.#policyPass = undefined;
    });
    return this.#policyPass;
  }

  async #refresh(): Promise<void> {
    const signal = this.#lifetime.signal;
    const { assignmentId, deploymentId, account, store, onApplied, onError } = this.#options;
    while (this.#refreshRequested && !signal.aborted) {
      this.#refreshRequested = false;
      try {
        const link = await account();
        if (!link) continue;
        const { assertion } = await link.workPolicy(assignmentId, signal);
        const { payload } = await this.#verifier.verify(assertion, { audience: deploymentId });
        const claims = WorkPolicyClaimsSchema.parse(payload);
        const document = WorkPolicyDocumentSchema.parse({
          assignmentId: claims.assignmentId,
          deploymentId: claims.deploymentId,
          policy: claims.policy,
          revision: claims.revision,
          state: claims.state,
        });
        signal.throwIfAborted();
        const applied = await store.apply(document);
        if (applied.changed) void onApplied().catch(onError);
        if (applied.revision !== this.#reportedRevision) {
          const reply = await link.reportWorkPolicy(assignmentId, applied.revision, signal);
          if (reply.appliedRevision === applied.revision) this.#reportedRevision = applied.revision;
        }
      } catch (error) {
        if (!signal.aborted) onError(error);
      }
    }
  }

  async flush(signal: AbortSignal) {
    if (this.#auditPass) return this.#auditPass;
    this.#auditPass = this.#pushAudit(AbortSignal.any([signal, this.#lifetime.signal])).finally(
      () => {
        this.#auditPass = undefined;
      },
    );
    return this.#auditPass;
  }

  async #pushAudit(signal: AbortSignal): Promise<"empty" | "sent" | "unavailable"> {
    const { account, store, assignmentId, key } = this.#options;
    signal.throwIfAborted();
    const link = await account();
    if (!link) return "unavailable";
    const batch = await store.prepareAuditBatch();
    if (!batch) return "empty";
    const { through, ...values } = batch;
    const unsigned = { ...values, assignmentId };
    const signature = sign(null, workAuditSigningBytes(unsigned), key).toString("base64url");
    const result = await link.pushWorkAudit(
      WorkAuditPushSchema.parse({ ...unsigned, signature }),
      signal,
    );
    if (result.lastSequence < through) return "unavailable";
    await store.acknowledgeAuditBatch(through);
    return "sent";
  }

  async receive(input: unknown, kind: "changed" | "flush"): Promise<boolean> {
    const { assignmentId, deploymentId, origin, store } = this.#options;
    const { assertion } = WorkAuditFlushRequestSchema.parse(input);
    try {
      const { payload } = await this.#verifier.verify(assertion, {
        audience: origin,
        maxTokenAge: "30s",
      });
      const claims = (
        kind === "flush" ? WorkAuditFlushClaimsSchema : WorkPolicyChangedClaimsSchema
      ).parse(payload);
      if (
        claims.assignmentId !== assignmentId ||
        claims.deploymentId !== deploymentId ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 30
      )
        throw new Error("Wrong work Home");
    } catch (cause) {
      throw new OpensteerError({ code: "forbidden", message: "Invalid work Home notice", cause });
    }
    if (kind === "changed") {
      this.wake();
      return true;
    }
    const signal = AbortSignal.timeout(1_500);
    const drain = async () => {
      await store.offboard();
      this.wake();
      while (!signal.aborted) {
        const result = await this.flush(signal);
        if (result === "empty") return true;
        if (result === "unavailable") return false;
      }
      return false;
    };
    return Promise.race([drain().catch(() => false), sleep(1_500, false, { ref: false })]);
  }
}

export function registerWorkHomeRoutes(app: FastifyInstance, service: WorkHomeService): void {
  app.post(
    workPolicyChangedPath,
    { bodyLimit: 8_192, config: unversionedRoute },
    async (request, reply) => {
      await service.receive(request.body, "changed");
      return reply.code(204).send();
    },
  );
  app.post(
    workAuditFlushPath,
    { bodyLimit: 8_192, config: unversionedRoute },
    async (request, reply) => {
      const confirmed = await service.receive(request.body, "flush");
      return reply.code(confirmed ? 204 : 503).send();
    },
  );
}
