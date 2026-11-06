import { describe, expect, it } from "vitest";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import { initialPhoneMode, privateRouteOrigin } from "./private-phone-setup.js";
import { resumeStep, setupSteps } from "./setup-memory.js";

function status(mode: "connect" | "off" | "private", origin?: string) {
  return {
    access: {
      generation: 1,
      mode,
      route: origin ? { document: { route: { origin } } } : mode === "connect" ? {} : null,
    },
  } as unknown as PersonalRemoteAdministrationStatus;
}

describe("the phone step's starting choice", () => {
  it("opens on what is on now, recognising the tailnet address Opensteer shared", () => {
    const tailnet = "https://studio.tail2f9.ts.net";
    expect(
      initialPhoneMode({ connectAvailable: true, status: status("private", `${tailnet}/`), tailscaleOrigin: tailnet }),
    ).toBe("tailscale");
    expect(
      initialPhoneMode({ connectAvailable: true, status: status("private", "https://mac.example.com"), tailscaleOrigin: tailnet }),
    ).toBe("address");
    expect(initialPhoneMode({ connectAvailable: true, status: status("connect"), tailscaleOrigin: null })).toBe(
      "connect",
    );
  });

  it("suggests Connect when nothing is on, and Tailscale in a build without it", () => {
    expect(initialPhoneMode({ connectAvailable: true, status: status("off"), tailscaleOrigin: null })).toBe("connect");
    expect(initialPhoneMode({ connectAvailable: false, status: status("off"), tailscaleOrigin: null })).toBe(
      "tailscale",
    );
  });

  it("reads the private address only while private access is on", () => {
    expect(privateRouteOrigin(status("private", "https://studio.tail2f9.ts.net:8443/"))).toBe(
      "https://studio.tail2f9.ts.net:8443",
    );
    expect(privateRouteOrigin(status("connect"))).toBeNull();
    expect(privateRouteOrigin(null)).toBeNull();
  });
});

describe("resuming setup", () => {
  it("drops steps that do not apply and resumes a remembered one at the next that does", () => {
    const web = setupSteps({ mac: false, onThisComputer: false });
    expect(web).toEqual(["ai"]);
    expect(resumeStep(web, "phone")).toBe("ai");
    const linux = setupSteps({ mac: false, onThisComputer: true });
    expect(linux).toEqual(["ai", "phone"]);
    expect(resumeStep(linux, "permissions")).toBe("phone");
    expect(resumeStep(setupSteps({ mac: true, onThisComputer: true }), null)).toBe("ai");
  });
});
