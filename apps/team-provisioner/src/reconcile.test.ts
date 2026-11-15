import { createHash } from "node:crypto";
import type {
  DesiredHostedTeam,
  HostedTeamStatusReport,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { describe, expect, it, vi } from "vitest";
import {
  Reconciler,
  rolloutDeadlineMilliseconds,
  type AccountApi,
  type KubernetesApi,
  type ManagedNamespace,
  type ManagedDeployment,
} from "./reconcile.js";
import { AccountRequestError } from "./account.js";
import { KubernetesRequestError } from "./kubernetes.js";
import {
  appliedHashAnnotation,
  setupGenerationAnnotation,
  teamIdLabel,
  type KubernetesObject,
  type TeamImages,
} from "./template.js";

const pinned = (name: string, digit: string) =>
  `ghcr.io/steerlabs/${name}@sha256:${digit.repeat(64)}`;
const oldRelease = {
  host: pinned("opensteer-team-host", "1"),
};
const release: TeamImages = {
  host: pinned("opensteer-team-host", "2"),
};
const digest = (digit: string) => digit.repeat(64);
const teamId = (slug: string) => {
  const hex = createHash("sha256").update(slug).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function team(slug: string, overrides: Partial<DesiredHostedTeam> = {}): DesiredHostedTeam {
  return {
    id: teamId(slug),
    slug,
    state: "active",
    setupTokenDigest: digest("a"),
    setupGeneration: 1,
    ...overrides,
  };
}

/** A cluster that remembers what was applied and lets the test decide when pods are ready. */
class FakeCluster implements KubernetesApi {
  readonly calls: string[] = [];
  readonly deployments = new Map<string, KubernetesObject>();
  readonly settled = new Set<string>();
  readonly namespaces = new Map<string, ManagedNamespace>();
  readonly secrets = new Map<string, Record<string, string>>();

  async listNamespaces() {
    return [...this.namespaces.values()];
  }

  async listDeployments(): Promise<readonly ManagedDeployment[]> {
    return [...this.deployments.values()].map((set) => {
      const spec = set.spec as {
        replicas: number;
        template: {
          metadata: { annotations: Record<string, string> };
          spec: { containers: { name: string; image: string }[] };
        };
      };
      const image = (name: string) =>
        spec.template.spec.containers.find((container) => container.name === name)!.image;
      return {
        teamId: set.metadata.labels![teamIdLabel]!,
        appliedHash: set.metadata.annotations![appliedHashAnnotation]!,
        hostImage: image("host"),
        replicas: spec.replicas,
        setupGeneration: Number(spec.template.metadata.annotations[setupGenerationAnnotation]),
        settled: this.settled.has(set.metadata.namespace!),
      };
    });
  }

  async apply(object: KubernetesObject) {
    this.calls.push(`apply ${object.kind} ${object.metadata.namespace ?? object.metadata.name}`);
    if (object.kind === "Namespace")
      this.namespaces.set(object.metadata.name, { name: object.metadata.name, terminating: false });
    if (object.kind === "Deployment") {
      const namespace = object.metadata.namespace!;
      const previous = this.deployments.get(namespace);
      if (JSON.stringify(previous?.spec) !== JSON.stringify(object.spec))
        this.settled.delete(namespace);
      this.deployments.set(namespace, object);
    }
  }

  async readTeamSecret(namespace: string) {
    const secret = this.secrets.get(namespace);
    return (
      secret && {
        setupTokenDigest: secret["setup-token-digest"] ?? "",
        databaseUrl: secret["database-url"],
        databaseCa: secret["database-ca.pem"],
      }
    );
  }

  async createSecret(secret: KubernetesObject) {
    this.calls.push(`create Secret ${secret.metadata.namespace}`);
    this.secrets.set(secret.metadata.namespace!, {
      ...(secret.stringData as Record<string, string>),
    });
  }

  async writeTeamSecret(namespace: string, values: Readonly<Record<string, string>>) {
    this.calls.push(`write ${Object.keys(values).sort().join(",")} ${namespace}`);
    Object.assign(this.secrets.get(namespace)!, values);
  }

  async deleteNamespace(name: string) {
    this.calls.push(`delete Namespace ${name}`);
    this.namespaces.set(name, { name, terminating: true });
  }

  /** Puts a team on a release as though an earlier provisioner had rolled it there. */
  runs(slugs: readonly string[], images: TeamImages) {
    for (const slug of slugs) {
      const namespace = `team-${slug}`;
      const set = this.deployments.get(namespace)!;
      const spec = structuredClone(set.spec) as {
        template: { spec: { containers: { name: string; image: string }[] } };
      };
      for (const container of spec.template.spec.containers)
        if (container.name === "host") container.image = images[container.name];
      this.deployments.set(namespace, {
        ...set,
        spec,
        metadata: { ...set.metadata, annotations: { [appliedHashAnnotation]: `old-${slug}` } },
      });
      this.settled.add(namespace);
    }
  }

  image(slug: string): string {
    const spec = this.deployments.get(`team-${slug}`)!.spec as {
      template: { spec: { containers: { name: string; image: string }[] } };
    };
    return spec.template.spec.containers.find((container) => container.name === "host")!.image;
  }
}

class FakeAccount implements AccountApi {
  teams: DesiredHostedTeam[] = [];
  readonly reports: { id: string; report: HostedTeamStatusReport }[] = [];

  async desired() {
    return this.teams;
  }

  async report(id: string, report: HostedTeamStatusReport) {
    this.reports.push({ id, report });
  }

  last(id: string) {
    return this.reports.findLast((entry) => entry.id === id)?.report;
  }
}

function setup(now = { value: 0 }, databaseCa = "CA", cluster = new FakeCluster()) {
  const account = new FakeAccount();
  const database = {
    exists: vi.fn(async () => false),
    ensure: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const storage = { ensure: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const reconciler = new Reconciler({
    account,
    kubernetes: cluster,
    images: release,
    platform: {
      databaseIp: "10.1.1.1",
      databaseHost: "db.example.com",
      databaseCa,
      bucket: "teams",
    },
    database,
    storage,
    log: () => undefined,
    now: () => now.value,
  });
  return { account, cluster, reconciler, now, database, storage };
}

describe("Reconciler", () => {
  it("resumes after folder failure using the persisted identity before starting the Host", async () => {
    const { account, cluster, reconciler, database, storage } = setup();
    account.teams = [team("acme")];
    storage.ensure.mockRejectedValueOnce(new Error("storage unavailable"));
    await reconciler.pass();
    const secret = structuredClone(cluster.secrets.get("team-acme"));
    expect(cluster.deployments.size).toBe(0);
    expect(database.ensure).toHaveBeenCalledWith(teamId("acme"), secret!["database-url"]);
    await reconciler.pass();
    expect(cluster.secrets.get("team-acme")).toEqual(secret);
    expect(cluster.deployments.size).toBe(1);
  });

  it("refuses to invent a replacement installation for an orphaned database", async () => {
    const { account, cluster, reconciler, database } = setup();
    account.teams = [team("acme")];
    database.exists.mockResolvedValue(true);
    await reconciler.pass();
    expect(cluster.secrets.size).toBe(0);
    expect(cluster.deployments.size).toBe(0);
  });

  it("retains the namespace and withholds deletion until external cleanup succeeds", async () => {
    const { account, cluster, reconciler, database, storage } = setup();
    account.teams = [team("acme", { state: "deleted" })];
    cluster.namespaces.set("team-acme", { name: "team-acme", terminating: false });
    storage.delete.mockRejectedValueOnce(new Error("cleanup incomplete"));
    await reconciler.pass();
    expect(database.delete).toHaveBeenCalled();
    expect(cluster.namespaces.get("team-acme")?.terminating).toBe(false);
    expect(account.last(teamId("acme"))).toBeUndefined();
    await reconciler.pass();
    expect(cluster.namespaces.get("team-acme")?.terminating).toBe(true);
    expect(account.last(teamId("acme"))).toBeUndefined();
    cluster.namespaces.clear();
    await reconciler.pass();
    expect(account.last(teamId("acme"))?.phase).toBe("deleted");
  });

  it("creates a team once, keeps its generated secret, and reports it ready when its pod is", async () => {
    const { account, cluster, reconciler } = setup();
    const acme = team("acme");
    account.teams = [acme];

    await reconciler.pass();
    expect(cluster.calls).toEqual([
      "apply Namespace team-acme",
      "apply RoleBinding team-acme",
      "create Secret team-acme",
      "apply ServiceAccount team-acme",
      "apply ResourceQuota team-acme",
      "apply LimitRange team-acme",
      "apply NetworkPolicy team-acme",
      "apply Service team-acme",
      "apply Deployment team-acme",
    ]);
    expect(cluster.secrets.get("team-acme")?.["setup-token-digest"]).toBe(digest("a"));
    expect(cluster.image("acme")).toBe(release.host);
    expect(account.last(acme.id)).toMatchObject({ phase: "provisioning" });

    cluster.calls.length = 0;
    cluster.settled.add("team-acme");
    await reconciler.pass();
    await reconciler.pass();
    expect(cluster.calls).toEqual([]);
    expect(account.last(acme.id)).toEqual({
      phase: "ready",
      hostImage: release.host,
      observedSetupGeneration: 1,
      setupGeneration: 1,
    });
    expect(account.reports.filter((entry) => entry.report.phase === "ready")).toHaveLength(1);
  });

  it("rotates only the setup digest and restarts the Host for a new setup link", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("acme")];
    await reconciler.pass();
    cluster.settled.add("team-acme");
    const password = cluster.secrets.get("team-acme")!["host-private.pem"];
    cluster.calls.length = 0;

    account.teams = [team("acme", { setupTokenDigest: digest("b"), setupGeneration: 2 })];
    await reconciler.pass();
    expect(cluster.calls).toContain("write setup-token-digest team-acme");
    expect(cluster.calls).not.toContain("create Secret team-acme");
    expect(cluster.secrets.get("team-acme")).toMatchObject({
      "host-private.pem": password,
      "setup-token-digest": digest("b"),
    });
    // Says which generation it judged, so Account never applies it to a later one.
    expect(account.last(account.teams[0]!.id)).toMatchObject({
      phase: "provisioning",
      observedSetupGeneration: 0,
      setupGeneration: 2,
    });

    cluster.settled.add("team-acme");
    await reconciler.pass();
    expect(account.last(account.teams[0]!.id)).toMatchObject({
      phase: "ready",
      observedSetupGeneration: 2,
    });
  });

  it("moves every team onto a rotated database CA and rolls its Host", async () => {
    const first = setup();
    first.account.teams = [team("acme")];
    await first.reconciler.pass();
    const before = first.cluster.deployments.get("team-acme")!;

    const rotated = setup(undefined, "CA-2", first.cluster);
    rotated.account.teams = first.account.teams;
    await rotated.reconciler.pass();
    expect(rotated.cluster.calls).toContain("write database-ca.pem team-acme");
    expect(rotated.cluster.secrets.get("team-acme")!["database-ca.pem"]).toBe("CA-2");
    expect(JSON.stringify(rotated.cluster.deployments.get("team-acme")!.spec)).not.toBe(
      JSON.stringify(before.spec),
    );
  });

  it("rolls existing teams to a new release one at a time", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("aaa"), team("bbb"), team("ccc")];
    await reconciler.pass();
    cluster.runs(["aaa", "bbb", "ccc"], oldRelease);

    await reconciler.pass();
    expect([cluster.image("aaa"), cluster.image("bbb"), cluster.image("ccc")]).toEqual([
      release.host,
      oldRelease.host,
      oldRelease.host,
    ]);
    // Teams waiting their turn keep serving, and say so.
    expect(account.last(account.teams[1]!.id)).toMatchObject({
      phase: "ready",
      hostImage: oldRelease.host,
    });

    await reconciler.pass();
    expect(cluster.image("bbb")).toBe(oldRelease.host);

    cluster.settled.add("team-aaa");
    await reconciler.pass();
    expect([cluster.image("bbb"), cluster.image("ccc")]).toEqual([release.host, oldRelease.host]);
  });

  it("stops the fleet at a rollout that never becomes ready, and reports it failed", async () => {
    const { account, cluster, reconciler, now } = setup();
    account.teams = [team("aaa"), team("bbb")];
    await reconciler.pass();
    cluster.runs(["aaa", "bbb"], oldRelease);

    await reconciler.pass();
    now.value += rolloutDeadlineMilliseconds;
    await reconciler.pass();
    expect(account.last(account.teams[0]!.id)).toMatchObject({ phase: "failed" });
    expect(cluster.image("bbb")).toBe(oldRelease.host);

    // A new provisioner process has no memory of the failure; the unready team still holds.
    const restarted = new Reconciler({
      account,
      kubernetes: cluster,
      images: release,
      platform: {
        databaseIp: "10.1.1.1",
        databaseHost: "db.example.com",
        databaseCa: "CA",
        bucket: "teams",
      },
      database: { exists: async () => false, ensure: async () => {}, delete: async () => {} },
      storage: { ensure: async () => {}, delete: async () => {} },
      log: () => undefined,
    });
    await restarted.pass();
    expect(cluster.image("bbb")).toBe(oldRelease.host);
  });

  it("scales a suspended team to nothing and brings it back", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("acme")];
    await reconciler.pass();
    cluster.settled.add("team-acme");

    account.teams = [team("acme", { state: "suspended" })];
    await reconciler.pass();
    const replicas = () =>
      (cluster.deployments.get("team-acme")!.spec as { replicas: number }).replicas;
    expect(replicas()).toBe(0);
    expect(account.last(account.teams[0]!.id)).toMatchObject({ phase: "provisioning" });
    cluster.settled.add("team-acme");
    await reconciler.pass();
    expect(account.last(account.teams[0]!.id)).toMatchObject({ phase: "suspended" });

    account.teams = [team("acme")];
    await reconciler.pass();
    expect(replicas()).toBe(1);
  });

  it("deletes a deleted team's namespace and reports it gone only once it is", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("acme")];
    await reconciler.pass();
    account.teams = [team("acme", { state: "deleted", setupTokenDigest: null })];

    await reconciler.pass();
    cluster.settled.add("team-acme");
    await reconciler.pass();
    expect(cluster.calls.filter((call) => call.startsWith("delete"))).toEqual([
      "delete Namespace team-acme",
    ]);
    expect(account.last(account.teams[0]!.id)).not.toMatchObject({ phase: "deleted" });

    cluster.namespaces.delete("team-acme");
    await reconciler.pass();
    expect(account.last(account.teams[0]!.id)).toEqual({
      phase: "deleted",
      hostImage: null,
      observedSetupGeneration: 0,
      setupGeneration: 1,
    });
  });

  it("fails the pass when the cluster or Account refuses this provisioner, after trying every team", async () => {
    const forbidden = setup();
    forbidden.account.teams = [team("first"), team("second")];
    forbidden.cluster.apply = async () => {
      throw new KubernetesRequestError(403, "forbidden");
    };
    await expect(forbidden.reconciler.pass()).rejects.toMatchObject({ status: 403 });
    expect(forbidden.account.last(teamId("second"))).toBeUndefined();

    const refused = setup();
    refused.account.teams = [team("first")];
    refused.account.report = async () => {
      throw new AccountRequestError(401, "unauthorized");
    };
    await expect(refused.reconciler.pass()).rejects.toMatchObject({ status: 401 });
  });

  it("keeps reconciling other teams when one fails", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("broken", { setupTokenDigest: null }), team("fine")];
    await reconciler.pass();
    expect(cluster.deployments.has("team-broken")).toBe(false);
    expect(cluster.deployments.has("team-fine")).toBe(true);
  });
});
