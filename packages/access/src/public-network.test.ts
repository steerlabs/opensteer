import { describe, expect, it } from "vitest";
import {
  connectInOrder,
  resolvePublicAddress,
  resolvePublicAddresses,
  type ResolvedPublicAddress,
} from "./public-network.js";

const v6: ResolvedPublicAddress = { address: "2606:4700::6810:84e5", family: 6 };
const v4: ResolvedPublicAddress = { address: "104.16.132.229", family: 4 };

describe("connecting to a name's public addresses in order (pool agent review G7)", () => {
  it("makes exactly one attempt, the first address, when it connects", async () => {
    const tried: string[] = [];
    const result = await connectInOrder([v6, v4], async (address) => {
      tried.push(address.address);
      return address.address;
    });
    expect(result).toBe(v6.address);
    expect(tried).toEqual([v6.address]);
  });

  it("tries the next address only after the previous one failed, in order", async () => {
    const tried: string[] = [];
    const result = await connectInOrder([v6, v4], async (address) => {
      tried.push(address.address);
      if (address.family === 6) throw new Error("ENETUNREACH");
      return address.address;
    });
    expect(result).toBe(v4.address);
    expect(tried).toEqual([v6.address, v4.address]);
  });

  it("throws the last failure when none connects, and stops once aborted", async () => {
    await expect(
      connectInOrder([v6, v4], async (address) => {
        throw new Error(`refused ${address.family}`);
      }),
    ).rejects.toThrow("refused 4");
    const controller = new AbortController();
    controller.abort(new Error("closing"));
    await expect(connectInOrder([v6, v4], async () => "never", controller.signal)).rejects.toThrow(
      "closing",
    );
  });

  it("keeps the single-address answer an ordinary Home uses, and refuses any private answer", async () => {
    expect(await resolvePublicAddress("104.16.132.229")).toEqual(v4);
    expect(await resolvePublicAddresses("[2606:4700::6810:84e5]")).toEqual([v6]);
    await expect(resolvePublicAddresses("169.254.169.254")).rejects.toThrow("non-public");
    await expect(resolvePublicAddress("10.0.0.1")).rejects.toThrow("non-public");
  });
});
