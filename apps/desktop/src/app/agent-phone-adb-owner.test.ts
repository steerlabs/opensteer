import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { agentPhoneAdbServerOwner } from "./agent-phone-adb-owner.js";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => undefined, { [promisify.custom]: execute }) };
});
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("accepts only one macOS listener owned by this computer account", async () => {
  execute.mockResolvedValue({ stdout: `p123\nu${process.getuid!()}\nn127.0.0.1:5037\n` });
  expect(await agentPhoneAdbServerOwner("darwin")).toBe("macos:123");
  execute.mockResolvedValue({ stdout: `p123\nu${process.getuid!() + 1}\nn127.0.0.1:5037\n` });
  await expect(agentPhoneAdbServerOwner("darwin")).rejects.toThrow("not owned");
  execute.mockResolvedValue({
    stdout: `p123\nu${process.getuid!()}\nn127.0.0.1:5037\np456\nu${process.getuid!()}\nn*:5037\n`,
  });
  await expect(agentPhoneAdbServerOwner("darwin")).rejects.toThrow("not owned");
});
it("distinguishes an absent server from a failed ownership probe", async () => {
  execute.mockRejectedValue({ code: 1, stdout: "" });
  expect(await agentPhoneAdbServerOwner("darwin")).toBeNull();
  execute.mockRejectedValue({ code: "EACCES" });
  await expect(agentPhoneAdbServerOwner("darwin")).rejects.toThrow("could not verify");
});
it("pins the Linux listener socket and checks its UID", async () => {
  vi.mocked(readFile).mockResolvedValue(
    `header\n0: 0100007F:13AD 00000000:0000 0A 0:0 0:0 0 ${process.getuid!()} 0 123\n`,
  );
  expect(await agentPhoneAdbServerOwner("linux")).toBe("linux:123");
  vi.mocked(readFile).mockResolvedValue(
    `header\n0: 0100007F:13AD 00000000:0000 0A 0:0 0:0 0 ${process.getuid!() + 1} 0 123\n`,
  );
  await expect(agentPhoneAdbServerOwner("linux")).rejects.toThrow("not owned");
});
it("accepts only a verified Windows process generation", async () => {
  execute.mockResolvedValue({ stdout: "123:6389000000\r\n" });
  expect(await agentPhoneAdbServerOwner("win32")).toBe("windows:123:6389000000");
  execute.mockResolvedValue({ stdout: "untrusted\r\n" });
  await expect(agentPhoneAdbServerOwner("win32")).rejects.toThrow("not owned");
  execute.mockResolvedValue({ stdout: "" });
  expect(await agentPhoneAdbServerOwner("win32")).toBeNull();
});

it("does not mistake this user's IPv6-only listener for the IPv4 server", async () => {
  execute.mockResolvedValue({ stdout: `p123\nu${process.getuid!()}\nn[::1]:5037\n` });
  await expect(agentPhoneAdbServerOwner("darwin")).rejects.toThrow("not owned");
});
