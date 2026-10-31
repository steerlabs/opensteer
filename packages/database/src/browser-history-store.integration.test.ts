import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { browserHistoryMaxEntries, browserHistoryRetentionMs } from "@opensteer/protocol";
import { createDatabase, OpensteerStore } from "./index.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

const favicon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "keeps bounded profile history, visit counts and icons with owner-only erasure",
  async () => {
    const clone = await cloneTestDatabase("host");
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url, maxConnections: 3 });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const ownerId = await store.createUser("History owner");
    const stranger = await store.createUser("History stranger");
    const profile = await store.createBrowserProfile({
      ownerId,
      name: "History",
      idempotencyKey: randomUUID(),
    });
    const other = await store.createBrowserProfile({
      ownerId,
      name: "Other",
      idempotencyKey: randomUUID(),
    });
    const history = store.browserHistory;
    const profileId = profile.id;
    const visit = (
      url: string,
      extra: { typed?: boolean; now?: Date; favicon?: string; title?: string } = {},
    ) =>
      history.recordVisit({ profileId, ownerId, url, title: "Original", typed: false, ...extra });
    const list = () => history.list(profileId, ownerId);
    const url = "https://www.amazon.com/";
    expect(await history.retainIcon({ profileId, origin: "https://www.amazon.com", favicon })).toBe(
      false,
    );
    expect((await list()).icons).toEqual([]);
    expect(await visit(url, { typed: true })).toBe(true);
    expect(await history.retainIcon({ profileId, origin: "https://www.amazon.com", favicon })).toBe(
      true,
    );
    expect(await history.retainIcon({ profileId, origin: "https://www.amazon.com", favicon })).toBe(
      false,
    );
    await visit(url, { title: "Updated" });
    let result = await list();
    expect(result.entries).toMatchObject([{ url, title: "Updated", typedCount: 1, visitCount: 2 }]);
    const lastVisitAt = result.entries[0]!.lastVisitAt;
    const iconRef = result.icons[0]!.iconRef;
    expect(iconRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await history.icons(profileId, ownerId, [iconRef])).toEqual({
      icons: [{ iconRef, favicon }],
    });
    expect(await history.retitle({ profileId, url, title: "Updated" })).toBe(false);
    expect(await history.retitle({ profileId, url, title: "A".repeat(250) })).toBe(true);
    expect((await list()).entries[0]).toMatchObject({
      title: "A".repeat(200),
      typedCount: 1,
      visitCount: 2,
      lastVisitAt,
    });
    await history.recordVisit({
      profileId: other.id,
      ownerId,
      url,
      title: "Other",
      typed: true,
      favicon,
    });
    await visit("https://www.amazon.com/two");
    await history.remove({ profileId, ownerId, url, idempotencyKey: "remove-one" });
    const journal = await database
      .selectFrom("commands")
      .select("payload")
      .where("idempotencyKey", "=", "remove-one")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(journal.payload)).not.toContain(url);
    expect(journal.payload).toMatchObject({
      urlFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    await expect(
      history.remove({
        profileId,
        ownerId,
        url: "https://different.example/",
        idempotencyKey: "remove-one",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await list()).icons).toHaveLength(1);
    await history.remove({
      profileId,
      ownerId,
      url: "https://www.amazon.com/two",
      idempotencyKey: "remove-two",
    });
    expect(await list()).toEqual({ entries: [], icons: [] });
    expect(await history.icons(profileId, ownerId, [iconRef])).toEqual({ icons: [] });
    expect((await history.list(other.id, ownerId)).entries).toHaveLength(1);
    await expect(history.list(other.id, stranger)).rejects.toMatchObject({ code: "not_found" });
    await expect(history.icons(other.id, stranger, [iconRef])).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      history.remove({
        profileId: other.id,
        ownerId: stranger,
        url,
        idempotencyKey: "stranger-remove",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      history.clear({ profileId: other.id, ownerId: stranger, idempotencyKey: "stranger-clear" }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Erasure replays do not erase a subsequent, genuinely new visit.
    await visit(url);
    await history.remove({ profileId, ownerId, url, idempotencyKey: "remove-one" });
    expect((await list()).entries).toHaveLength(1);
    await expect(
      history.clear({ profileId, ownerId, idempotencyKey: "remove-one" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await history.clear({ profileId, ownerId, idempotencyKey: "clear" })).toBe(true);
    expect(await history.clear({ profileId, ownerId, idempotencyKey: "clear" })).toBe(false);
    expect(await history.clear({ profileId, ownerId, idempotencyKey: "empty-clear" })).toBe(false);
    expect(await history.retitle({ profileId, url, title: "Cannot resurrect" })).toBe(false);
    expect(await history.retainIcon({ profileId, origin: "https://www.amazon.com", favicon })).toBe(
      false,
    );
    expect(await list()).toEqual({ entries: [], icons: [] });

    const now = Date.now();
    await visit("https://expired.test/", {
      now: new Date(now - browserHistoryRetentionMs - 1),
      favicon,
    });
    expect((await list()).entries).toHaveLength(0);
    expect((await list()).icons).toHaveLength(0);
    await visit("https://recent.test/", { favicon });
    await database
      .updateTable("browserHistoryEntries")
      .set({ lastVisitAt: new Date(now - browserHistoryRetentionMs - 1) })
      .where("profileId", "=", profileId)
      .execute();
    expect(await list()).toEqual({ entries: [], icons: [] });
    expect(await history.icons(profileId, ownerId, [iconRef])).toEqual({ icons: [] });
    // Expiry must erase idle profiles too, without waiting for another visit.
    await database
      .updateTable("browserHistoryEntries")
      .set({ lastVisitAt: new Date(now - browserHistoryRetentionMs - 1) })
      .where("profileId", "=", other.id)
      .execute();
    const recentUrl = "https://retained.test/";
    // Insert directly so another visit's inline pruning cannot hide a broken global sweep.
    await database
      .insertInto("browserHistoryEntries")
      .values({
        profileId: other.id,
        url: recentUrl,
        origin: "https://retained.test",
        title: "Recent",
        typedCount: 0,
        visitCount: 1,
        lastVisitAt: new Date(now),
      })
      .execute();
    expect(await history.prune()).toEqual(
      expect.arrayContaining([
        { profileId, ownerId },
        { profileId: other.id, ownerId },
      ]),
    );
    expect(await history.prune()).toEqual([]);
    expect(
      await database.selectFrom("browserHistoryEntries").select(["profileId", "url"]).execute(),
    ).toEqual([{ profileId: other.id, url: recentUrl }]);
    expect(await database.selectFrom("browserHistoryIcons").selectAll().execute()).toEqual([]);
    const retained = Array.from({ length: browserHistoryMaxEntries }, (_, index) => ({
      profileId,
      url: `https://site-${index}.test/`,
      origin: `https://site-${index}.test`,
      title: "Retained",
      typedCount: 0,
      visitCount: 1,
      lastVisitAt: new Date(now + index),
    }));
    await database.insertInto("browserHistoryEntries").values(retained).execute();
    await database
      .insertInto("browserHistoryIcons")
      .values(
        retained.map(({ profileId, origin }) => ({
          profileId,
          origin,
          iconRef,
          favicon,
        })),
      )
      .execute();
    await visit(`https://site-${browserHistoryMaxEntries}.test/`, {
      now: new Date(now + browserHistoryMaxEntries),
      favicon,
    });
    result = await list();
    expect(result.entries).toHaveLength(browserHistoryMaxEntries);
    expect(result.entries[0]?.url).toBe(`https://site-${browserHistoryMaxEntries}.test/`);
    expect(result.entries.some((entry) => entry.url === "https://site-0.test/")).toBe(false);
    expect(result.icons).toHaveLength(browserHistoryMaxEntries);
    expect(
      await database
        .selectFrom("browserHistoryIcons")
        .selectAll()
        .where("profileId", "=", profileId)
        .execute(),
    ).toHaveLength(browserHistoryMaxEntries);
    await store.deleteBrowserProfile({ ownerId, profileId });
    expect(
      await database
        .selectFrom("browserHistoryEntries")
        .selectAll()
        .where("profileId", "=", profileId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("browserHistoryIcons")
        .selectAll()
        .where("profileId", "=", profileId)
        .execute(),
    ).toEqual([]);
    await expect(list()).rejects.toMatchObject({ code: "not_found" });
    expect((await history.list(other.id, ownerId)).entries).toHaveLength(1);
  },
);
