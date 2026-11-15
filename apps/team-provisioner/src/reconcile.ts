import { createHash } from "node:crypto";
import { teamDatabaseUrl, type TeamDatabase } from "./database.js";
import type { TeamStorage } from "./storage.js";
import type {
  DesiredHostedTeam,
  HostedTeamStatusReport,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { AccountRequestError } from "./account.js";
import { KubernetesRequestError } from "./kubernetes.js";
import {
  appliedHashAnnotation,
  newTeamSecret,
  renderTeam,
  teamNamespace,
  type KubernetesObject,
  type TeamImages,
  type TeamPlatform,
} from "./template.js";

/** A rollout that hasn't become ready by then is reported failed and holds the fleet. */
export const rolloutDeadlineMilliseconds = 10 * 60 * 1_000;

export interface ManagedNamespace {
  readonly name: string;
  readonly terminating: boolean;
}

export interface ManagedDeployment {
  readonly teamId: string;
  readonly appliedHash: string | null;
  readonly hostImage: string | null;
  readonly replicas: number;
  readonly setupGeneration: number;
  /** Every pod runs the current template and is ready; with no replicas, no pod remains. */
  readonly settled: boolean;
}

export interface KubernetesApi {
  listNamespaces(): Promise<readonly ManagedNamespace[]>;
  listDeployments(): Promise<readonly ManagedDeployment[]>;
  apply(object: KubernetesObject): Promise<void>;
  /** The team's installation Secret, or undefined when it has none yet. */
  readTeamSecret(namespace: string): Promise<TeamSecretValues | undefined>;
  createSecret(secret: KubernetesObject): Promise<void>;
  writeTeamSecret(namespace: string, values: Readonly<Record<string, string>>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
}

export interface TeamSecretValues {
  readonly setupTokenDigest: string;
  readonly databaseUrl: string | undefined;
  readonly databaseCa: string | undefined;
}

type ProvisionerPlatform = Omit<TeamPlatform, "databaseCaDigest"> & {
  readonly databaseHost: string;
  readonly databaseCa: string;
};

export interface AccountApi {
  desired(): Promise<readonly DesiredHostedTeam[]>;
  report(id: string, report: HostedTeamStatusReport): Promise<void>;
}

export interface ReconcilerLog {
  (event: string, fields: Readonly<Record<string, unknown>>): void;
}

/**
 * Makes the cluster match Account's desired teams, one pass at a time. New teams start on the
 * release this provisioner was deployed with; existing teams move to it one at a time, and any
 * team on that release that is not ready holds every other team where it is.
 */
export class Reconciler {
  readonly #account: AccountApi;
  readonly #kubernetes: KubernetesApi;
  readonly #images: TeamImages;
  readonly #replicas: number;
  readonly #platform: ProvisionerPlatform & TeamPlatform;
  readonly #database: TeamDatabase;
  readonly #storage: TeamStorage;
  readonly #log: ReconcilerLog;
  readonly #now: () => number;
  readonly #unready = new Map<string, { readonly hash: string | null; readonly since: number }>();
  readonly #reported = new Map<string, string>();

  constructor(input: {
    readonly account: AccountApi;
    readonly kubernetes: KubernetesApi;
    readonly images: TeamImages;
    readonly replicas?: number;
    readonly platform: ProvisionerPlatform;
    readonly database: TeamDatabase;
    readonly storage: TeamStorage;
    readonly log: ReconcilerLog;
    readonly now?: () => number;
  }) {
    this.#account = input.account;
    this.#kubernetes = input.kubernetes;
    this.#images = input.images;
    this.#replicas = input.replicas ?? 1;
    this.#platform = {
      ...input.platform,
      databaseCaDigest: createHash("sha256").update(input.platform.databaseCa).digest("hex"),
    };
    this.#database = input.database;
    this.#storage = input.storage;
    this.#log = input.log;
    this.#now = input.now ?? Date.now;
  }

  async pass(): Promise<void> {
    const [teams, namespaces, deployments] = await Promise.all([
      this.#account.desired(),
      this.#kubernetes.listNamespaces(),
      this.#kubernetes.listDeployments(),
    ]);
    const running = new Map(deployments.map((set) => [set.teamId, set]));
    const plans = teams.map((team) => ({ team, set: running.get(team.id), ...this.#render(team) }));
    let rolling = plans.some(
      ({ team, set, hash }) => team.state === "active" && set?.appliedHash === hash && !set.settled,
    );
    let refused: Error | undefined;
    for (const { team, set, objects, hash } of plans) {
      try {
        if (team.state === "deleted") {
          await this.#delete(team, namespaces, set);
          continue;
        }
        if (set?.appliedHash === hash) {
          await this.#report(team, this.#status(team, set, hash));
          continue;
        }
        // The team asked for this restart itself, or has no running Host to disturb.
        const requested =
          !set ||
          team.state === "suspended" ||
          set.replicas === 0 ||
          set.setupGeneration !== team.setupGeneration;
        if (!requested) {
          if (rolling) {
            await this.#report(team, this.#status(team, set, set.appliedHash));
            continue;
          }
          rolling = true;
          this.#log("rollout.started", { team: team.slug, hostImage: this.#images.host });
        }
        await this.#apply(team, objects);
        await this.#report(team, this.#status(team, set, hash));
      } catch (error) {
        this.#log("team.failed", {
          team: team.slug,
          error: error instanceof KubernetesRequestError ? error.message : "Team operation failed",
        });
        if (refusesProvisioner(error)) refused ??= error;
      }
    }
    // One team's own failure is that team's; a refusal of this identity fails every team alike.
    if (refused) throw refused;
  }

  #render(team: DesiredHostedTeam) {
    const objects = renderTeam({
      id: team.id,
      slug: team.slug,
      name: team.name ?? team.slug,
      images: this.#images,
      platform: this.#platform,
      replicas: team.state === "suspended" ? 0 : this.#replicas,
      setupGeneration: team.setupGeneration,
    });
    return { objects, hash: objects.at(-1)!.metadata.annotations![appliedHashAnnotation]! };
  }

  async #apply(team: DesiredHostedTeam, objects: readonly KubernetesObject[]): Promise<void> {
    const namespace = teamNamespace(team.slug);
    await this.#kubernetes.apply(objects[0]!);
    await this.#kubernetes.apply(objects[1]!);
    let stored = await this.#kubernetes.readTeamSecret(namespace);
    if (stored === undefined) {
      if (await this.#database.exists(team.id))
        throw new Error("Existing team installation Secret is missing");
      if (!team.setupTokenDigest) throw new Error("A new team needs a setup digest");
      await this.#kubernetes.createSecret(
        newTeamSecret({
          id: team.id,
          slug: team.slug,
          setupTokenDigest: team.setupTokenDigest,
          databaseUrl: teamDatabaseUrl(team.id, this.#platform.databaseHost),
          databaseCa: this.#platform.databaseCa,
        }),
      );
      stored = await this.#kubernetes.readTeamSecret(namespace);
    } else {
      const changes: Record<string, string> = {};
      if (team.setupTokenDigest && stored.setupTokenDigest !== team.setupTokenDigest)
        changes["setup-token-digest"] = team.setupTokenDigest;
      if (stored.databaseCa !== this.#platform.databaseCa)
        changes["database-ca.pem"] = this.#platform.databaseCa;
      if (Object.keys(changes).length) await this.#kubernetes.writeTeamSecret(namespace, changes);
    }
    if (!stored?.databaseUrl) throw new Error("Team installation is incomplete");
    await this.#database.ensure(team.id, stored.databaseUrl);
    await this.#storage.ensure(team.id, namespace);
    for (const object of objects.slice(2)) await this.#kubernetes.apply(object);
  }

  /** What the team runs right now, judged against the spec it is meant to be running. */
  #status(
    team: DesiredHostedTeam,
    set: ManagedDeployment | undefined,
    hash: string | null,
  ): HostedTeamStatusReport {
    const current = set !== undefined && set.appliedHash === hash && set.settled;
    if (team.state === "suspended") {
      this.#unready.delete(team.id);
      return {
        phase: current ? "suspended" : "provisioning",
        hostImage: null,
        observedSetupGeneration: 0,
      };
    }
    if (current) {
      this.#unready.delete(team.id);
      return {
        phase: "ready",
        hostImage: set.hostImage,
        observedSetupGeneration: set.setupGeneration,
      };
    }
    const now = this.#now();
    const unready = this.#unready.get(team.id);
    if (!unready || unready.hash !== hash) this.#unready.set(team.id, { hash, since: now });
    else if (now - unready.since >= rolloutDeadlineMilliseconds) {
      return {
        phase: "failed",
        hostImage: null,
        observedSetupGeneration: 0,
        message: "The team did not become ready; rollouts are held until it does.",
      };
    }
    return { phase: "provisioning", hostImage: null, observedSetupGeneration: 0 };
  }

  async #delete(
    team: DesiredHostedTeam,
    namespaces: readonly ManagedNamespace[],
    set: ManagedDeployment | undefined,
  ): Promise<void> {
    if (set && (set.replicas !== 0 || !set.settled)) {
      const objects = renderTeam({
        id: team.id,
        slug: team.slug,
        name: team.name ?? team.slug,
        images: this.#images,
        platform: this.#platform,
        replicas: 0,
        setupGeneration: team.setupGeneration,
      });
      await this.#kubernetes.apply(objects.at(-1)!);
      return;
    }
    this.#unready.delete(team.id);
    await this.#database.delete(team.id);
    await this.#storage.delete(team.id);
    const namespace = namespaces.find((candidate) => candidate.name === teamNamespace(team.slug));
    if (namespace) {
      if (!namespace.terminating) {
        this.#log("team.deleting", { team: team.slug });
        await this.#kubernetes.deleteNamespace(namespace.name);
      }
      return;
    }
    await this.#report(team, { phase: "deleted", hostImage: null, observedSetupGeneration: 0 });
  }

  async #report(team: DesiredHostedTeam, observed: HostedTeamStatusReport): Promise<void> {
    const report = { ...observed, setupGeneration: team.setupGeneration };
    const key = JSON.stringify(report);
    if (this.#reported.get(team.id) === key) return;
    this.#reported.delete(team.id);
    await this.#account.report(team.id, report);
    this.#reported.set(team.id, key);
    if (report.phase === "failed") this.#log("team.unready", { team: team.slug });
  }
}

function refusesProvisioner(error: unknown): error is Error {
  return (
    (error instanceof KubernetesRequestError || error instanceof AccountRequestError) &&
    (error.status === 401 || error.status === 403)
  );
}
