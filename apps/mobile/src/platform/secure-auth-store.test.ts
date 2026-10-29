import type { AccountCredential, HostCredential } from "@opensteer/client/auth";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, HostInstanceIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { MemorySecureStore } from "./memory-secure-store.js";
import { createSecureAuthStore } from "./secure-auth-store.js";
import { createSecureRecordStore } from "./secure-record-store.js";

const updatedAt = "2026-09-14T00:00:00.000Z";

const accountCredential = (): AccountCredential => ({
  accessToken: "account-access-token-0123456789",
  accessTokenExpiresAt: updatedAt,
  email: "person@example.com",
  grantedScopes: ["openid", "profile"],
  issuerOrigin: "https://account.example.com",
  refreshToken: "account-refresh-token-0123456789",
  subject: ControlPlaneAccountIdSchema.parse("acct_0192f4a1-3333-4000-8000-000000000003"),
  updatedAt,
});

const hostCredential = (deploymentId: string): HostCredential => ({
  accessToken: `host-access-token-${deploymentId}`,
  accessTokenExpiresAt: updatedAt,
  canonicalOrigin: "https://host.example.com",
  deploymentId: DeploymentIdSchema.parse(deploymentId),
  grantedScopes: ["openid", "host:access"],
  hostInstanceId: HostInstanceIdSchema.parse("hst_0192f4a1-2222-4000-8000-000000000002"),
  hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
  refreshToken: `host-refresh-token-${deploymentId}`,
  updatedAt,
});

const first = "dep_0192f4a1-1111-4000-8000-000000000001";
const second = "dep_0192f4a1-1111-4000-8000-000000000002";

const store = () => {
  const secureStore = new MemorySecureStore();
  const auth = createSecureAuthStore(
    createSecureRecordStore({ keyPrefix: "opensteer.auth", secureStore }),
  );
  return { auth, secureStore };
};

describe("createSecureAuthStore", () => {
  it("keeps one record per Host credential", async () => {
    const { auth, secureStore } = store();
    await auth.setHost(hostCredential(first));
    await auth.setHost(hostCredential(second));

    expect(secureStore.keys).toContain(`opensteer.auth.host.${first}`);
    expect(secureStore.keys).toContain(`opensteer.auth.host.${second}`);
    expect((await auth.load()).hosts.map(({ deploymentId }) => deploymentId)).toEqual([
      first,
      second,
    ]);
  });

  it("replaces a Host credential rather than adding a second", async () => {
    const { auth } = store();
    await auth.setHost(hostCredential(first));
    const replacement = { ...hostCredential(first), accessToken: "host-access-token-replaced" };

    const state = await auth.setHost(replacement);

    expect(state.hosts).toEqual([replacement]);
  });

  it("removes only the named Deployment's record", async () => {
    const { auth, secureStore } = store();
    await auth.setHost(hostCredential(first));
    await auth.setHost(hostCredential(second));

    const state = await auth.clearHost(first);

    expect(state.hosts.map(({ deploymentId }) => deploymentId)).toEqual([second]);
    expect(secureStore.keys).not.toContain(`opensteer.auth.host.${first}`);
    expect(secureStore.keys).toContain(`opensteer.auth.host.${second}`);
  });

  it("clears several Deployments at once and refuses duplicates", async () => {
    const { auth } = store();
    await auth.setHost(hostCredential(first));
    await auth.setHost(hostCredential(second));

    expect((await auth.clearHosts([first, second])).hosts).toEqual([]);
    expect(() => auth.clearHosts([first, first])).toThrow(/duplicate/u);
  });

  it("signs out an identity this release cannot parse instead of failing", async () => {
    const { auth, secureStore } = store();
    await auth.setAccount(accountCredential());
    secureStore.put(
      "opensteer.auth.account.g0.0",
      JSON.stringify({ shape: "from another release" }),
    );

    expect((await auth.load()).account).toBeNull();
  });

  it("never writes a credential into the index", async () => {
    const { auth, secureStore } = store();
    const credential = hostCredential(first);
    await auth.setHost(credential);

    expect(secureStore.peek("opensteer.auth.hosts.g0.0")).toBe(JSON.stringify([first]));
  });

  it("touches only the record that changed, never the credentials it keeps", async () => {
    const { auth, secureStore } = store();
    await auth.setHost(hostCredential(first));
    await auth.setHost(hostCredential(second));
    const written: string[] = [];
    secureStore.interrupt = (step) => {
      if (step.startsWith("set:")) written.push(step.slice(4));
    };

    await auth.setHost({ ...hostCredential(first), accessToken: "host-access-token-replaced" });

    // The index already lists both, and the second Deployment's credential did
    // not change: rewriting either would multiply Keychain work and the number
    // of ways one sign-in can damage another.
    expect(written.every((key) => key.startsWith(`opensteer.auth.host.${first}`))).toBe(true);
  });

  it("removes without rewriting the credentials it keeps", async () => {
    const { auth, secureStore } = store();
    await auth.setHost(hostCredential(first));
    await auth.setHost(hostCredential(second));
    const written: string[] = [];
    secureStore.interrupt = (step) => {
      if (step.startsWith("set:")) written.push(step.slice(4));
    };

    await auth.clearHost(first);

    expect(written.some((key) => key.startsWith(`opensteer.auth.host.${second}`))).toBe(false);
  });

  it("leaves the index naming only credentials that were stored when a record write fails", async () => {
    const { auth, secureStore } = store();
    await auth.setHost(hostCredential(first));
    secureStore.interrupt = (step) => {
      if (step === `set:opensteer.auth.host.${second}.g0.0`) {
        throw new Error("The operating system stopped this app.");
      }
    };

    await expect(auth.setHost(hostCredential(second))).rejects.toThrow(/stopped this app/u);

    secureStore.interrupt = () => undefined;
    expect((await auth.load()).hosts.map(({ deploymentId }) => deploymentId)).toEqual([first]);
    expect(secureStore.peek("opensteer.auth.hosts.g0.0")).toBe(JSON.stringify([first]));
  });
});
