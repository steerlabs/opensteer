import { createHash } from "node:crypto";
import type {
  DesiredHostedTeam,
  HostedTeamStatusReport,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { describe, expect, it } from "vitest";
import {
  Reconciler,
  rolloutDeadlineMilliseconds,
  type AccountApi,
  type KubernetesApi,
  type ManagedNamespace,
  type ManagedStatefulSet,
} from "./reconcile.js";
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
  gateway: pinned("opensteer-team-gateway", "1"),
};
const release: TeamImages = {
  host: pinned("opensteer-team-host", "2"),
  gateway: pinned("opensteer-team-gateway", "2"),
  postgres: pinned("postgres", "3"),
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
  readonly statefulSets = new Map<string, KubernetesObject>();
  readonly settled = new Set<string>();
  readonly namespaces = new Map<string, ManagedNamespace>();
  readonly secrets = new Map<string, Record<string, string>>();

  async listNamespaces() {
    return [...this.namespaces.values()];
  }

  async listStatefulSets(): Promise<readonly ManagedStatefulSet[]> {
    return [...this.statefulSets.values()].map((set) => {
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
        gatewayImage: image("gateway"),
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
    if (object.kind === "StatefulSet") {
      const namespace = object.metadata.namespace!;
      const previous = this.statefulSets.get(namespace);
      if (JSON.stringify(previous?.spec) !== JSON.stringify(object.spec))
        this.settled.delete(namespace);
      this.statefulSets.set(namespace, object);
    }
  }

  async readSetupTokenDigest(namespace: string) {
    return this.secrets.get(namespace)?.["setup-token-digest"];
  }

  async createSecret(secret: KubernetesObject) {
    this.calls.push(`create Secret ${secret.metadata.namespace}`);
    this.secrets.set(secret.metadata.namespace!, {
      ...(secret.stringData as Record<string, string>),
    });
  }

  async writeSetupTokenDigest(namespace: string, value: string) {
    this.calls.push(`write digest ${namespace}`);
    this.secrets.get(namespace)!["setup-token-digest"] = value;
  }

  async deleteNamespace(name: string) {
    this.calls.push(`delete Namespace ${name}`);
    this.namespaces.set(name, { name, terminating: true });
  }

  /** Puts a team on a release as though an earlier provisioner had rolled it there. */
  runs(slugs: readonly string[], images: Pick<TeamImages, "gateway" | "host">) {
    for (const slug of slugs) {
      const namespace = `team-${slug}`;
      const set = this.statefulSets.get(namespace)!;
      const spec = structuredClone(set.spec) as {
        template: { spec: { containers: { name: string; image: string }[] } };
      };
      for (const container of spec.template.spec.containers)
        if (container.name === "host" || container.name === "gateway")
          container.image = images[container.name];
      this.statefulSets.set(namespace, {
        ...set,
        spec,
        metadata: { ...set.metadata, annotations: { [appliedHashAnnotation]: `old-${slug}` } },
      });
      this.settled.add(namespace);
    }
  }

  image(slug: string): string {
    const spec = this.statefulSets.get(`team-${slug}`)!.spec as {
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

function setup(now = { value: 0 }) {
  const cluster = new FakeCluster();
  const account = new FakeAccount();
  const reconciler = new Reconciler({
    account,
    kubernetes: cluster,
    images: release,
    log: () => undefined,
    now: () => now.value,
  });
  return { account, cluster, reconciler, now };
}

describe("Reconciler", () => {
  it("creates a team once, keeps its generated secret, and reports it ready when its pod is", async () => {
    const { account, cluster, reconciler } = setup();
    const acme = team("acme");
    account.teams = [acme];

    await reconciler.pass();
    expect(cluster.calls).toEqual([
      "apply Namespace team-acme",
      "apply ResourceQuota team-acme",
      "apply LimitRange team-acme",
      "apply NetworkPolicy team-acme",
      "apply Service team-acme",
      "create Secret team-acme",
      "apply StatefulSet team-acme",
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
    });
    expect(account.reports.filter((entry) => entry.report.phase === "ready")).toHaveLength(1);
  });

  it("rotates only the setup digest and restarts the Host for a new setup link", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("acme")];
    await reconciler.pass();
    cluster.settled.add("team-acme");
    const password = cluster.secrets.get("team-acme")!["postgres-password"];
    cluster.calls.length = 0;

    account.teams = [team("acme", { setupTokenDigest: digest("b"), setupGeneration: 2 })];
    await reconciler.pass();
    expect(cluster.calls).toContain("write digest team-acme");
    expect(cluster.calls).not.toContain("create Secret team-acme");
    expect(cluster.secrets.get("team-acme")).toMatchObject({
      "postgres-password": password,
      "setup-token-digest": digest("b"),
    });
    expect(account.last(account.teams[0]!.id)).toMatchObject({ phase: "provisioning" });

    cluster.settled.add("team-acme");
    await reconciler.pass();
    expect(account.last(account.teams[0]!.id)).toMatchObject({
      phase: "ready",
      observedSetupGeneration: 2,
    });
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
      (cluster.statefulSets.get("team-acme")!.spec as { replicas: number }).replicas;
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
    });
  });

  it("keeps reconciling other teams when one fails", async () => {
    const { account, cluster, reconciler } = setup();
    account.teams = [team("broken", { setupTokenDigest: null }), team("fine")];
    await reconciler.pass();
    expect(cluster.statefulSets.has("team-broken")).toBe(false);
    expect(cluster.statefulSets.has("team-fine")).toBe(true);
  });
});
