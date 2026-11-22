import { describe, expect, it, vi } from "vitest";
import { MemorySecureStore } from "./memory-secure-store.js";
import { createSecureRecordStore } from "./secure-record-store.js";
import { signInStorage, signInStorageSentence } from "./sign-in-storage.js";

/*
 * An unsigned build, or one whose Keychain entitlement is missing, fails every Keychain call
 * with Expo's own exception text. A person reads one plain sentence instead; the log keeps
 * the exception.
 */

const raw =
  "Calling the 'setValueWithKeyAsync' function has failed → Caused by: A required entitlement isn't present.";

function failing(): MemorySecureStore {
  const store = new MemorySecureStore();
  store.setItemAsync = async () => {
    throw new Error(raw);
  };
  store.getItemAsync = async () => {
    throw new Error(raw);
  };
  return store;
}

describe("the phone's sign-in storage", () => {
  it("says one plain sentence where the Keychain refuses, and logs what it said", async () => {
    const report = vi.fn();
    const records = createSecureRecordStore({
      keyPrefix: "test",
      secureStore: signInStorage(failing(), "iPhone", report),
    });
    const refused = await records.write("account", "credential").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(
      "Opensteer couldn't save your sign-in on this iPhone. Try again.",
    );
    expect(((refused as Error).cause as Error).message).toBe(raw);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: raw }));
    await expect(records.read("account")).rejects.toThrow(signInStorageSentence("iPhone"));
  });

  it("names the phone it runs on", () => {
    expect(signInStorageSentence("phone")).toBe(
      "Opensteer couldn't save your sign-in on this phone. Try again.",
    );
  });

  it("passes what the Keychain holds through untouched", async () => {
    const records = createSecureRecordStore({
      keyPrefix: "test",
      secureStore: signInStorage(new MemorySecureStore(), "iPhone", vi.fn()),
    });
    await records.write("account", "credential");
    await expect(records.read("account")).resolves.toBe("credential");
  });
});
