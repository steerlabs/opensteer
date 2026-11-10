import { describe, expect, it } from "vitest";
import { PagedList } from "./team-paging.js";

/** A Host list of `total` rows, answered in pages of `size`, each held until released. */
function host(total: number, size: number) {
  const pending: { cursor: string | null; release: () => void }[] = [];
  const read = (cursor: string | null) =>
    new Promise<{ items: number[]; nextCursor: string | null; accessRevision: number }>(
      (resolve) => {
        const start = cursor ? Number(cursor) : 0;
        const end = Math.min(total, start + size);
        pending.push({
          cursor,
          release: () =>
            resolve({
              items: Array.from({ length: end - start }, (_, index) => start + index),
              nextCursor: end < total ? String(end) : null,
              accessRevision: 7,
            }),
        });
      },
    );
  const answer = async () => {
    pending.shift()!.release();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { pending, read, answer };
}

describe("a paged team list", () => {
  it("reaches the 31st row of a 31-row list, keeps the first page's revision, and stops at the end", async () => {
    const { read, answer } = host(31, 30);
    const list = new PagedList(read);
    const loaded = list.reload();
    await answer();
    await loaded;
    expect(list.getState()).toMatchObject({ nextCursor: "30", first: { accessRevision: 7 } });
    expect(list.getState().items).toHaveLength(30);
    const more = list.more();
    await answer();
    await more;
    expect(list.getState().items.at(-1)).toBe(30);
    expect(list.getState()).toMatchObject({ nextCursor: null, capped: false });
  });

  it("drops a page answered for an earlier load after a reset", async () => {
    const { read, answer, pending } = host(60, 30);
    const list = new PagedList(read);
    const first = list.reload();
    await answer();
    await first;
    void list.more();
    const late = pending.shift()!;
    const again = list.reload();
    late.release();
    await answer();
    await again;
    expect(list.getState().items).toEqual(Array.from({ length: 30 }, (_, index) => index));
  });

  it("stops offering more at its bound", async () => {
    const { read, answer } = host(500, 100);
    const list = new PagedList(read, 150);
    const first = list.reload();
    await answer();
    await first;
    const more = list.more();
    await answer();
    await more;
    expect(list.getState()).toMatchObject({ nextCursor: null, capped: true });
    expect(list.getState().items).toHaveLength(150);
  });
});
