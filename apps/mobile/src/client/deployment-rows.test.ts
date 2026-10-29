import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import { testDeploymentConnection } from "../../test-support/deployment-fixtures.js";
import {
  deploymentSignInLabel,
  deploymentStatusDetail,
  describeDeploymentRow,
  type DeploymentFacts,
} from "./deployment-rows.js";

const held: DeploymentFacts = { attachment: null, credentialed: true, verification: null };
const signedOut: DeploymentFacts = { attachment: null, credentialed: false, verification: null };
const attached: DeploymentFacts = { ...held, attachment: "connected" };

describe("describeDeploymentRow", () => {
  it("calls a deployment with a held credential signed in, and nothing more", () => {
    const row = describeDeploymentRow(testDeploymentConnection({}), held);

    // "Connected" is a socket, and there is none: a credential in protected
    // storage says only that this phone could sign in without asking again.
    expect(row.status).toBe("signed-in");
    expect(row.kindLabel).toBe("Server");
    expect(row.origin).toBe("https://host.example.com");
  });

  it("does not call a deployment the Account lists Cloud, and marks it managed", () => {
    const row = describeDeploymentRow(
      testDeploymentConnection({
        source: {
          issuer: "https://account.example.com",
          kind: "account",
          subject: ControlPlaneAccountIdSchema.parse("acct_0192f4a1-3333-4000-8000-000000000003"),
        },
      }),
      held,
    );

    // The directory says who may reach a deployment, never who runs it.
    expect(row.kindLabel).toBe("Server");
    expect(row.accountManaged).toBe(true);
  });

  it("asks for a sign-in when no credential is held", () => {
    expect(describeDeploymentRow(testDeploymentConnection({}), signedOut).status).toBe(
      "needs-sign-in",
    );
  });

  it("calls a personal computer with no live route unavailable, credential or not", () => {
    const connection = testDeploymentConnection({ kind: "personal", reachable: false });

    expect(describeDeploymentRow(connection, held).status).toBe("unavailable");
    expect(describeDeploymentRow(connection, signedOut).status).toBe("unavailable");
  });

  it("puts what a verification found ahead of every other state", () => {
    const connection = testDeploymentConnection({});

    expect(
      describeDeploymentRow(connection, { ...attached, verification: "host-too-old" }).status,
    ).toBe("update-required");
    expect(
      describeDeploymentRow(connection, { ...attached, verification: "identity-mismatch" }).status,
    ).toBe("unverified");
  });
});

describe("deployment status wording", () => {
  it("names the side that needs updating, rather than saying only that they differ", () => {
    const connection = testDeploymentConnection({});

    expect(
      deploymentStatusDetail(
        describeDeploymentRow(connection, { ...attached, verification: "host-too-old" }),
      ),
    ).toMatch(/Update the deployment\.$/u);
    expect(
      deploymentStatusDetail(
        describeDeploymentRow(connection, { ...attached, verification: "client-too-old" }),
      ),
    ).toMatch(/Update this app\.$/u);
  });
});

describe("the door a row that needs a credential opens", () => {
  it("sends a self-hosted deployment to its own authorization server", () => {
    const row = describeDeploymentRow(testDeploymentConnection({}), signedOut);

    expect(row.status).toBe("needs-sign-in");
    expect(row.signIn).toBe("host-oauth");
    expect(deploymentSignInLabel("host-oauth")).toBe("Sign in");
  });

  it("signs a Connect computer in with the grant the Account issues", () => {
    const row = describeDeploymentRow(
      testDeploymentConnection({ kind: "personal", route: { kind: "connect" } }),
      signedOut,
    );

    expect(row.signIn).toBe("account-grant");
    expect(deploymentSignInLabel("account-grant")).toBe("Sign in");
    expect(deploymentStatusDetail(row)).toBe("Sign in to this deployment to see your work.");
  });

  it("asks for a pairing code where only the operator can supply one", () => {
    const row = describeDeploymentRow(
      testDeploymentConnection({ kind: "personal", route: { kind: "private" } }),
      signedOut,
    );

    expect(row.signIn).toBe("pairing-code");
    expect(deploymentSignInLabel("pairing-code")).toBe("Enter a pairing code");
    expect(deploymentStatusDetail(row)).toBe(
      "Enter a new pairing code from the computer that hosts it.",
    );
  });

  it("offers no door where there is nothing to sign in to, or nothing to fix", () => {
    expect(describeDeploymentRow(testDeploymentConnection({}), attached).signIn).toBeNull();
    expect(
      describeDeploymentRow(testDeploymentConnection({}), {
        ...signedOut,
        verification: "client-too-old",
      }).signIn,
    ).toBeNull();
    expect(
      describeDeploymentRow(
        testDeploymentConnection({ kind: "personal", reachable: false }),
        signedOut,
      ).signIn,
    ).toBeNull();
  });

  it("uses the exchange failure's recovery door and keeps transport failures offline", () => {
    const connection = testDeploymentConnection({
      kind: "personal",
      route: { kind: "connect" },
    });

    const accountRequired = describeDeploymentRow(connection, {
      ...signedOut,
      sessionFailure: "account-required",
    });
    expect(accountRequired).toMatchObject({
      signIn: "account-grant",
      status: "needs-sign-in",
    });
    expect(deploymentStatusDetail(accountRequired)).toMatch(/Opensteer Account again/u);

    expect(
      describeDeploymentRow(connection, {
        ...signedOut,
        sessionFailure: "pairing-required",
      }),
    ).toMatchObject({ signIn: "pairing-code", status: "needs-sign-in" });
    expect(
      describeDeploymentRow(connection, { ...signedOut, sessionFailure: "unavailable" }),
    ).toMatchObject({ signIn: null, status: "offline" });
  });
});
