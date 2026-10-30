import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopAppProtocolHandler,
  desktopAppEntryUrl,
  registerDesktopAppScheme,
} from "./app-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Desktop app protocol", () => {
  it("registers a standard secure scheme without CSP bypass or network privileges", () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerDesktopAppScheme({
      handle: vi.fn(),
      registerSchemesAsPrivileged,
      unhandle: vi.fn(),
    });
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        privileges: expect.objectContaining({
          bypassCSP: false,
          corsEnabled: false,
          secure: true,
          standard: true,
          supportFetchAPI: false,
        }),
        scheme: "app",
      },
    ]);
  });

  it("serves bounded bundled assets and SPA routes with a network-denying CSP", async () => {
    const root = await temporaryDirectory("opensteer-app-protocol-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><div id=root></div>");
    await writeFile(path.join(root, "assets", "app.js"), "export {};");
    const handle = createDesktopAppProtocolHandler(root);

    const document = await handle(new Request(`${desktopAppEntryUrl}workspaces/one`));
    expect(document.status).toBe(200);
    expect(await document.text()).toContain("id=root");
    expect(document.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(document.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(document.headers.get("content-security-policy")).toContain("media-src 'none'");
    expect(document.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(document.headers.get("permissions-policy")).toContain("camera=()");
    expect(document.headers.get("cross-origin-opener-policy")).toBe("same-origin");

    const script = await handle(new Request(`${desktopAppEntryUrl}assets/app.js`));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("export {};");
  });

  it("rejects other authorities, writes, malformed escapes, and symlinked assets", async () => {
    const root = await temporaryDirectory("opensteer-app-policy-");
    const outside = await temporaryDirectory("opensteer-app-outside-");
    await writeFile(path.join(root, "index.html"), "safe");
    await writeFile(path.join(outside, "secret.js"), "secret");
    if (process.platform !== "win32") {
      await symlink(path.join(outside, "secret.js"), path.join(root, "secret.js"), "file");
    }
    const handle = createDesktopAppProtocolHandler(root);

    await expect(handle(new Request("app://attacker/"))).resolves.toMatchObject({ status: 404 });
    await expect(
      handle(new Request(desktopAppEntryUrl, { method: "POST" })),
    ).resolves.toMatchObject({ status: 405 });
    await expect(handle(new Request("app://opensteer/%00.js"))).resolves.toMatchObject({
      status: 404,
    });
    if (process.platform !== "win32") {
      await expect(handle(new Request("app://opensteer/secret.js"))).resolves.toMatchObject({
        status: 404,
      });
    }
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
