import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { DeploymentIdSchema, UserIdSchema } from "@opensteer/core";
import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopIntegrationAuthorizations } from "./integration-authorizations.js";
import { DesktopLoginSession } from "./login-session.js";

const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(
  "ioa_00000000-0000-4000-8000-000000000001",
);
const otherAttemptId = IntegrationAuthorizationAttemptIdSchema.parse(
  "ioa_00000000-0000-4000-8000-000000000002",
);
const deploymentId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001");
const userId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
const returnProof = "P".repeat(43);
const form = `deployment_id=${deploymentId}&attempt_id=${attemptId}&return=${returnProof}`;
const oauth = {
  accountCallback: "com.opensteer.desktop:/oauth/account-callback",
  application: "desktop",
  hostCallback: "com.opensteer.desktop:/oauth/host-callback",
} as never;

const instances: DesktopIntegrationAuthorizations[] = [];

const consoleUser = (userId: number) => `<dict>
  <key>kCGSSessionOnConsoleKey</key><true/>
  <key>kCGSSessionUserIDKey</key><integer>${userId}</integer>
  <key>kCGSessionLoginDoneKey</key><true/>
</dict>`;
const registry = (...users: readonly number[]) =>
  `<plist><dict><key>IOConsoleUsers</key><array>${users.map(consoleUser).join("")}</array></dict></plist>`;

function authorizations(input: { sessionless?: boolean; logins?: () => readonly number[] } = {}) {
  const open = vi.fn();
  const power = new EventEmitter();
  const instance = new DesktopIntegrationAuthorizations(oauth, open);
  instances.push(instance);
  if (!input.sessionless)
    instance.useLoginSession(
      new DesktopLoginSession(power, "darwin", {
        read: async () => registry(...(input.logins?.() ?? [501])),
        user: 501,
      }),
    );
  return { instance, open, power };
}

const started = (expiresAt = new Date(Date.now() + 60_000).toISOString()) => ({
  attemptId,
  deploymentId,
  expiresAt,
  userId,
});

function post(port: number): Promise<number> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/u.exec(data)?.[1] ?? 0)));
    socket.write(
      `POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${form.length}\r\n\r\n${form}`,
    );
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});

describe("DesktopIntegrationAuthorizations loopback return", () => {
  it("delivers a posted proof through the same broker as the app link", async () => {
    const { instance, open } = authorizations();
    const received = vi.fn();
    instance.attach({ deploymentId, userId }, received);
    const port = (await instance.prepareReturn(deploymentId))!.port;
    await instance.register(started());
    expect(await post(port)).toBe(200);
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith({ attemptId, deploymentId, returnProof }),
    );
    expect(open).toHaveBeenCalledWith(deploymentId);
  });

  it("refuses a forwarded proof for an attempt this app never started", async () => {
    const { instance, open } = authorizations();
    const received = vi.fn();
    instance.attach({ deploymentId, userId }, received);
    const port = (await instance.prepareReturn(deploymentId))!.port;
    expect(await post(port)).toBe(404);
    expect(received).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("has no authority after a restart, whatever the old attempt id", async () => {
    const before = authorizations();
    await before.instance.prepareReturn(deploymentId);
    await before.instance.register(started());
    await before.instance.close();
    const after = authorizations();
    const received = vi.fn();
    after.instance.attach({ deploymentId, userId }, received);
    const port = (await after.instance.prepareReturn(deploymentId))!.port;
    expect(after.instance.find({ attemptId, deploymentId })).toBeNull();
    expect(await post(port)).toBe(404);
    expect(received).not.toHaveBeenCalled();
  });

  it("holds a return across a renderer reload", async () => {
    const { instance } = authorizations();
    const port = (await instance.prepareReturn(deploymentId))!.port;
    await instance.register(started());
    expect(await post(port)).toBe(200);
    const received = vi.fn();
    instance.attach({ deploymentId, userId }, received);
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith({ attemptId, deploymentId, returnProof }),
    );
  });

  it("offers no port before it can read the login session", async () => {
    const { instance } = authorizations({ sessionless: true });
    expect(await instance.prepareReturn(deploymentId)).toBeNull();
  });

  it("offers no port while another login is on this Mac", async () => {
    const { instance } = authorizations({ logins: () => [501, 502] });
    expect(await instance.prepareReturn(deploymentId)).toBeNull();
  });

  it("refuses a proof at acceptance once another login appears", async () => {
    let logins: readonly number[] = [501];
    const { instance } = authorizations({ logins: () => logins });
    const received = vi.fn();
    instance.attach({ deploymentId, userId }, received);
    const port = (await instance.prepareReturn(deploymentId))!.port;
    await instance.register(started());
    logins = [501, 502];
    expect(await post(port)).toBe(404);
    expect(received).not.toHaveBeenCalled();
  });

  it("closes the listener on the session's resign and keeps the attempt pending", async () => {
    let logins: readonly number[] = [501];
    const { instance, power } = authorizations({ logins: () => logins });
    const port = (await instance.prepareReturn(deploymentId))!.port;
    await instance.register(started());
    logins = [502];
    power.emit("user-did-resign-active");
    await vi.waitFor(async () => expect(await listening(port)).toBe(false));
    expect(instance.find({ attemptId, deploymentId })).not.toBeNull();
    expect(await instance.prepareReturn(deploymentId)).toBeNull();
    logins = [501];
    power.emit("user-did-become-active");
    await vi.waitFor(async () => expect(await listening(port)).toBe(true));
  });

  it("closes the listener when the last attempt is forgotten or cleared", async () => {
    const { instance } = authorizations();
    const first = (await instance.prepareReturn(deploymentId))!;
    await instance.register(started(), first.preparation);
    await instance.forget({ attemptId, deploymentId });
    expect(await listening(first.port)).toBe(false);
    const again = (await instance.prepareReturn(deploymentId))!;
    await instance.register(started(), again.preparation);
    await instance.clear(deploymentId);
    expect(await listening(again.port)).toBe(false);
  });

  it("keeps a delayed attempt's listener when a no-port attempt comes and goes", async () => {
    const { instance } = authorizations();
    const received = vi.fn();
    instance.attach({ deploymentId, userId }, received);
    const delayed = (await instance.prepareReturn(deploymentId))!;
    const other = { ...started(), attemptId: otherAttemptId };
    await instance.register(other);
    await instance.forget(other);
    expect(await listening(delayed.port)).toBe(true);
    await instance.register(started(), delayed.preparation);
    expect(await post(delayed.port)).toBe(200);
    await vi.waitFor(() => expect(received).toHaveBeenCalled());
  });

  it("releases an outstanding preparation on sign-out instead of waiting out its grace", async () => {
    const { instance } = authorizations();
    const prepared = (await instance.prepareReturn(deploymentId))!;
    await instance.clear();
    expect(await listening(prepared.port)).toBe(false);
  });
});
