import { expect, it, vi } from "vitest";
import type { DeploymentAccessDeployment } from "@opensteer/protocol/desktop";
import { ComputerFactsStore, type ComputerFacts } from "./computer-facts.js";

const computer = (id: string, origin = `https://${id}.example.test`) =>
  ({ id, canonicalOrigin: origin }) as DeploymentAccessDeployment;
const said = (needsYou: number): ComputerFacts => ({
  homeName: null,
  needsYou,
  unread: false,
});

function deferred() {
  let resolve!: (facts: ComputerFacts) => void;
  const promise = new Promise<ComputerFacts>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

it("shares a read already under way, keeps what an unreachable computer said last and drops removed ones", async () => {
  const read = vi.fn(async (row: DeploymentAccessDeployment) => said(row.id === "a" ? 1 : 2));
  const store = new ComputerFactsStore(read);
  const changed = vi.fn();
  store.subscribe(changed);
  const both = [computer("a"), computer("b")];

  const first = store.refresh(both);
  expect(store.refresh([...both].reverse())).toBe(first);
  await first;
  expect(read).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledOnce();
  expect(store.getSnapshot().get("b")?.needsYou).toBe(2);

  read.mockImplementation(async (row) => {
    if (row.id === "b") throw new Error("asleep");
    return said(5);
  });
  await store.refresh(both);
  expect(store.getSnapshot().get("a")?.needsYou).toBe(5);
  expect(store.getSnapshot().get("b")?.needsYou).toBe(2);

  await store.refresh([computer("a")]);
  expect([...store.getSnapshot().keys()]).toEqual(["a"]);
});

it("a read of a set that changed while it ran never overwrites the newer one, even back to the same set", async () => {
  const first = deferred();
  const moved = deferred();
  const again = deferred();
  const read = vi
    .fn<(row: DeploymentAccessDeployment) => Promise<ComputerFacts>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(moved.promise)
    .mockReturnValueOnce(again.promise);
  const store = new ComputerFactsStore(read);
  const a = [computer("a")];
  const reads = [
    store.refresh(a),
    store.refresh([computer("a", "https://moved.example.test")]),
    store.refresh(a),
  ];
  again.resolve(said(3));
  moved.resolve(said(2));
  first.resolve(said(1));
  await Promise.all(reads);
  expect(read).toHaveBeenCalledTimes(3);
  expect(store.getSnapshot().get("a")?.needsYou).toBe(3);
});
