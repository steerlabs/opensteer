import { once } from "node:events";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import {
  teamPartnerMaxFrameBytes,
  type HostApiCommandInput,
} from "../packages/protocol/src/index.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { startTeamSystem } from "./team-system.test-support.js";
import type { TeamPartnerNetwork } from "../apps/host/src/team-partners/service.js";

type Host = Awaited<ReturnType<typeof startTeamSystem>>;
type Session = Awaited<ReturnType<Host["session"]>>;

export async function pairFixture() {
  const hosts: Host[] = [];
  const targets = new Map<string, Host>();
  const sockets = new Set<WebSocket>();
  const override = new Map<string, unknown>();
  let discoveries = 0;
  const network: TeamPartnerNetwork = {
    async discover(origin, signal) {
      discoveries++;
      if (override.has(origin)) return override.get(origin);
      const target = targets.get(origin);
      if (!target) throw new Error("Unknown test partner");
      return (await fetch(new URL("/.well-known/opensteer", target.origin), { signal })).json();
    },
    async connectSocket(origin, path, signal) {
      const target = targets.get(origin);
      if (!target) throw new Error("Unknown test partner");
      const socket = new WebSocket(
        new URL(path, target.origin).toString().replace(/^http/u, "ws"),
        {
          maxPayload: teamPartnerMaxFrameBytes,
          followRedirects: false,
        },
      );
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
      await withTimeout(once(socket, "open"), 3000, {
        signal,
        timeoutError: () => new Error("Partner test socket never opened"),
      });
      return socket;
    },
  };
  try {
    for (const name of ["Alpha", "Bravo"]) {
      const host = await startTeamSystem(name, { teamPartnerNetwork: network });
      hosts.push(host);
      targets.set(host.canonicalOrigin, host);
    }
    const [a, b] = hosts as [Host, Host];
    const [aUser, bUser] = await Promise.all([a.setup(), b.setup()]);
    const [aSession, bSession] = await Promise.all([
      a.session(aUser, "Alpha admin"),
      b.session(bUser, "Bravo admin"),
    ]);
    return {
      a,
      b,
      aUser,
      bUser,
      aSession,
      bSession,
      sockets,
      override,
      get discoveries() {
        return discoveries;
      },
      async close() {
        await Promise.all(hosts.map((host) => host.close()));
      },
    };
  } catch (error) {
    await Promise.all(hosts.map((host) => host.close()));
    throw error;
  }
}

export async function command(session: Session, input: HostApiCommandInput) {
  const result = await session.rpc["commands.dispatch"](input);
  if (!result.ok)
    throw new Error(
      `Partner command ${input.type} failed: ${result.error.code}: ${result.error.message} (${result.error.reason})`,
    );
  return result.data;
}
export async function list(session: Session) {
  const result = await session.rpc["team.partners.list"]({});
  if (!result.ok) throw new Error("Partner list failed");
  return result.data.links;
}
export async function invite(session: Session) {
  const result = await command(session, { type: "team.partner.invite.create" });
  if (result.type !== "team.partner.invite.create") throw new Error("No partner invite");
  return result.offer;
}
export async function redeem(session: Session, offer: string) {
  const result = await command(session, { type: "team.partner.invite.redeem", offer });
  if (result.type !== "team.partner.invite.redeem") throw new Error("No partner link");
  return result.link;
}
export async function active(a: Session, b: Session) {
  await vi.waitFor(
    async () => {
      expect(
        (await list(a)).filter((row) => row.state !== "revoked"),
        "Alpha never authenticated an active partner",
      ).toMatchObject([{ state: "active", connected: true }]);
      expect(
        (await list(b)).filter((row) => row.state !== "revoked"),
        "Bravo never authenticated an active partner",
      ).toMatchObject([{ state: "active", connected: true }]);
    },
    { timeout: 5000 },
  );
}
