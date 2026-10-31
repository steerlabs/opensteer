import { agentPhoneAdb } from "@opensteer/agent-phone-setup";
import { connectAgentPhone, type AgentPhoneUsbDevice } from "@opensteer/agent-phone-setup/webusb";
import type { DesktopAgentPhoneAdbBridge } from "@opensteer/protocol/desktop";
import { beforeEach, expect, it, vi } from "vitest";
import { connectPhoneForSetup } from "./agent-phone-connection.js";

vi.mock("@opensteer/agent-phone-setup", () => ({ agentPhoneAdb: vi.fn() }));
vi.mock("@opensteer/agent-phone-setup/webusb", () => ({
  connectAgentPhone: vi.fn(),
  agentPhoneCredentialStore: vi.fn(),
}));
const device = {
  serial: "oneplus",
  raw: { vendorId: 10864, productId: 20199 },
} as AgentPhoneUsbDevice;
beforeEach(() => vi.resetAllMocks());
function nativeBridge() {
  return {
    open: vi.fn<DesktopAgentPhoneAdbBridge["open"]>(async () => "connected"),
    call: vi.fn<DesktopAgentPhoneAdbBridge["call"]>(async () => ({
      kind: "getProp",
      value: "GM1915",
    })),
    close: vi.fn(async () => undefined),
    onAuthorize: vi.fn(() => vi.fn()),
  };
}
it("selects the existing native connection before touching USB and uses the same setup port", async () => {
  const native = nativeBridge();
  const abort = new AbortController();
  const connection = await connectPhoneForSetup(device, {
    native,
    signal: abort.signal,
    onAuthorizePrompt: vi.fn(),
  });
  expect(connectAgentPhone).not.toHaveBeenCalled();
  expect(connection.kind).toBe("connected");
  if (connection.kind !== "connected") throw new Error("No setup connection");
  expect(await connection.adb.getProp("ro.product.model")).toBe("GM1915");
  expect(native.open).toHaveBeenCalledWith({
    device: { vendorId: 10864, productId: 20199, serialNumber: "oneplus" },
    sessionId: expect.any(String),
  });
  await connection.close();
  expect(native.close).toHaveBeenCalledOnce();
});
it("uses direct USB when no native server has the phone", async () => {
  const native = nativeBridge();
  native.open.mockResolvedValue("direct");
  const adb = { close: vi.fn() };
  vi.mocked(connectAgentPhone).mockResolvedValue({ kind: "connected", adb } as unknown as Awaited<
    ReturnType<typeof connectAgentPhone>
  >);
  const port = { getProp: vi.fn() };
  vi.mocked(agentPhoneAdb).mockReturnValue(port as unknown as ReturnType<typeof agentPhoneAdb>);
  const connection = await connectPhoneForSetup(device, {
    native,
    signal: new AbortController().signal,
    onAuthorizePrompt: vi.fn(),
  });
  expect(connectAgentPhone).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalledOnce();
  expect(connection).toMatchObject({ kind: "connected", adb: port });
});
it("closes a native open that finishes after cancellation without opening USB", async () => {
  const native = nativeBridge();
  const opening = Promise.withResolvers<"connected">();
  native.open.mockReturnValue(opening.promise);
  const abort = new AbortController();
  const prompt = vi.fn();
  const connecting = connectPhoneForSetup(device, {
    native,
    signal: abort.signal,
    onAuthorizePrompt: prompt,
  });
  abort.abort(new Error("Setup cancelled"));
  opening.resolve("connected");
  await expect(connecting).rejects.toThrow("Setup cancelled");
  expect(native.close).toHaveBeenCalled();
  expect(connectAgentPhone).not.toHaveBeenCalled();
  expect(native.onAuthorize.mock.results[0]?.value).toHaveBeenCalledOnce();
});
