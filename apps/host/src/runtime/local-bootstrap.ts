import { OpensteerError } from "@opensteer/core";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import type { OpensteerStore } from "@opensteer/database";
import { LocalBootstrapSchema, type LocalBootstrap } from "@opensteer/protocol";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";

/**
 * Material a same-machine supervisor needs to finish standing up a Host that is
 * reachable only from its own machine.
 *
 * Both fields describe work the deployment owes itself rather than work a
 * person owes it. `setupUrl` carries the loopback first-owner code so nobody
 * has to copy it out of a configuration file; the enrollment token enrolls the
 * one computer every same-machine supervisor runs, the Main Runner. Setup
 * becomes null once claimed. The enrollment token remains available while its
 * runtime is active: a consumed token is bound to the exact identity that
 * consumed it, and replay lets a supervisor finish cleanly if the Host
 * committed enrollment just before the runtime process restarted.
 *
 * Nothing else is minted here. A pending enrollment is a promise that some
 * computer will redeem it, and this route cannot know which other computers
 * its caller supervises. A supervisor that runs a browser or messaging
 * computer mints that token itself and configures the Host with it, exactly as
 * a managed Deployment does — the packaged Personal stack does precisely that
 * for the messaging service it supervises, through
 * `OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN`.
 */
const mainRunnerIdempotencyKey = "deployment-local-main-runner";
const mainRunnerEnrollmentLifetimeSeconds = 24 * 60 * 60;

export class LocalBootstrapService {
  readonly #publicUrl: URL;
  readonly #requireSetupCredential: boolean;
  readonly #runners: RunnerAuthenticator;
  readonly #setupToken: string;
  readonly #store: OpensteerStore;

  constructor(options: {
    readonly publicUrl: URL;
    readonly requireSetupCredential: boolean;
    readonly runners: RunnerAuthenticator;
    readonly setupToken: string;
    readonly store: OpensteerStore;
  }) {
    this.#publicUrl = options.publicUrl;
    this.#requireSetupCredential = options.requireSetupCredential;
    this.#runners = options.runners;
    this.#setupToken = options.setupToken;
    this.#store = options.store;
  }

  /**
   * Idempotent. Repeated calls return the same unconsumed enrollment token
   * rather than minting more, so a supervisor that restarts does not leave a
   * trail of pending enrollments behind it.
   */
  async describe(authorization?: string): Promise<LocalBootstrap> {
    if (this.#requireSetupCredential) this.#requireCredential(authorization);
    if (this.#requireSetupCredential) {
      await this.#store.upgradeLegacyPersonalMainRunnerBrowserGrant();
    }
    const [administrator, mainRunner] = await Promise.all([
      this.#store.hasInstanceAdministrator(),
      this.#store.deploymentMainRunnerState(),
    ]);
    return LocalBootstrapSchema.parse({
      runnerEnrollmentToken: mainRunner === "revoked" ? null : await this.#issueMainRunnerToken(),
      setupUrl: administrator ? null : this.#setupUrl(),
    });
  }

  #requireCredential(authorization: string | undefined): void {
    if (!authorization) {
      throw new OpensteerError({ code: "not_found", message: "Local setup is unavailable" });
    }
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!/^[^\s]{32,4096}$/u.test(token)) {
      throw new OpensteerError({ code: "forbidden", message: "Local owner proof is invalid" });
    }
    if (!equalSecretDigests(digestSecret(this.#setupToken), digestSecret(token))) {
      throw new OpensteerError({ code: "forbidden", message: "Local owner proof is invalid" });
    }
  }

  #setupUrl(): string {
    const url = new URL("/setup", this.#publicUrl);
    // The code rides in the fragment so it is never sent to the server as part
    // of a request line, and so it cannot reach an access log or a referrer.
    url.hash = new URLSearchParams([["token", this.#setupToken]]).toString();
    return url.toString();
  }

  async #issueMainRunnerToken(): Promise<string | null> {
    try {
      const enrollment = await this.#runners.createInitialMainEnrollment({
        allowedModules: ["agents", "browser"],
        createdBy: null,
        idempotencyKey: mainRunnerIdempotencyKey,
        lifetimeSeconds: mainRunnerEnrollmentLifetimeSeconds,
      });
      return enrollment.token;
    } catch (error) {
      // A Main Runner that enrolled and was later revoked needs a deliberate
      // operator replacement, not an automatic one. Report no token rather than
      // failing the whole bootstrap response.
      if (error instanceof OpensteerError && error.code === "conflict") return null;
      throw error;
    }
  }
}
