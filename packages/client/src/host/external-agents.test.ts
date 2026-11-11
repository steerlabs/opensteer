import type {
  AgentConnectionConsent,
  PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  answerAgentConnection,
  externalAgentGuides,
  externalAgentsReach,
  guideAddress,
} from "./connected-agents.js";

const personal = { exposure: "loopback", publicOrigin: "http://127.0.0.1:4310" } as const;
function remote(mode: "off" | "connect" | "private", origin: string | null) {
  return {
    status: {
      access: { mode, route: origin === null ? null : { document: { route: { origin } } } },
    } as unknown as PersonalRemoteAdministrationStatus,
    error: null,
  };
}

describe("where cloud agents reach this Deployment", () => {
  it("waits for Remote access instead of telling the person to turn it on", () => {
    expect(
      externalAgentsReach({ identity: personal, remote: { status: null, error: null } }),
    ).toEqual({ kind: "loading" });
    expect(externalAgentsReach({ identity: personal, remote: remote("off", null) })).toEqual({
      kind: "needs-remote",
    });
  });

  it("never offers ChatGPT or Claude a private network address, but still gives it to any other agent", () => {
    const reach = externalAgentsReach({
      identity: personal,
      remote: remote("private", "https://mac.tailnet.example"),
    });
    if (reach.kind !== "ready") throw new Error("Expected an address");
    const [chatgpt, claude, other] = externalAgentGuides;
    expect(guideAddress(chatgpt, reach).kind).toBe("blocked");
    expect(guideAddress(claude, reach).kind).toBe("blocked");
    expect(guideAddress(other, reach)).toEqual({
      kind: "address",
      url: "https://mac.tailnet.example/internal/v1/mcp",
    });
  });

  it("gives a networked Host's own origin without reading Remote access", () => {
    expect(
      externalAgentsReach({
        identity: { exposure: "networked", publicOrigin: "https://steer.example" },
        remote: { status: null, error: null },
      }),
    ).toEqual({
      kind: "ready",
      personal: false,
      reach: "internet",
      url: "https://steer.example/internal/v1/mcp",
    });
  });
});

describe("answering an agent's connection request", () => {
  const consent: AgentConnectionConsent = {
    requestId: "r".repeat(43),
    clientName: "ChatGPT",
    redirectUri: "https://chatgpt.com/connector/oauth/callback",
    // The origin the agent signed in through, not the phone's route to the Host.
    resource: "https://mac.connect.example/internal/v1/mcp",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  it("approves with the chosen ceiling, then finishes sign-in on the agent's origin", async () => {
    const host = new MockHostClient({ latencyMs: 0, connectionConsent: consent });
    await host.load();
    try {
      const completion = await answerAgentConnection(host, consent, {
        kind: "approve",
        label: "  My ChatGPT  ",
        accessMode: "auto",
      });
      expect(completion).toBe(
        `https://mac.connect.example/oauth/mcp/complete?request=${consent.requestId}`,
      );
      const listed = await host.rpc["connections.list"]({});
      expect(listed.ok && listed.data.connections).toEqual([
        expect.objectContaining({
          label: "My ChatGPT",
          accessMode: "auto",
        }),
      ]);
    } finally {
      host.dispose();
    }
  });

  it("denies without creating a connection, and still hands the agent back its answer", async () => {
    const host = new MockHostClient({ latencyMs: 0, connectionConsent: consent });
    await host.load();
    try {
      await expect(answerAgentConnection(host, consent, { kind: "deny" })).resolves.toContain(
        "/oauth/mcp/complete",
      );
      const listed = await host.rpc["connections.list"]({});
      expect(listed.ok && listed.data.connections).toEqual([]);
    } finally {
      host.dispose();
    }
  });
});
