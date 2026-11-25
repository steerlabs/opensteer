import type { HostClient } from "../host/client.js";
import { expect, it, vi } from "vitest";

const unavailable = [
  {
    reason: "offline",
    connection: { network: "offline" },
    words: "Not stopped. You're offline.",
  },
  {
    reason: "recovering",
    connection: { phase: "recovering" },
    words: "Not stopped. Can't reach Studio Mac.",
  },
  {
    reason: "no session scope",
    connection: { scope: null },
    words: "Not stopped. Can't reach Studio Mac.",
  },
] as const;

interface StopSurface {
  readonly client: HostClient;
  readonly shown: HTMLElement;
  readonly stop: HTMLButtonElement | null | undefined;
}

/** One matrix for both renderers, mounted with each app's own interaction-test harness. */
export function testUnsentSessionStops(
  press: (stop: HTMLButtonElement) => Promise<void>,
  surfaces: Readonly<Record<string, () => Promise<StopSurface>>>,
) {
  it.each(
    Object.entries(surfaces).flatMap(([surface, mount]) =>
      unavailable.map((unavailability) => ({ surface, mount, ...unavailability })),
    ),
  )(
    "$surface explains a Stop that could not be sent ($reason)",
    async ({ mount, connection, words }) => {
      const { client, shown, stop } = await mount();
      expect(stop).toBeTruthy();
      const dispatch = vi.spyOn(client, "dispatch");
      // The view is already open when the connection becomes unavailable to the Stop owner.
      vi.spyOn(client.connection, "getSnapshot").mockReturnValue({
        ...client.connection.getSnapshot(),
        name: "Studio Mac",
        ...connection,
      });
      await press(stop!);
      expect(
        dispatch.mock.calls.filter(([command]) => command.type === "agent.session.stop"),
      ).toHaveLength(0);
      expect(shown.textContent).toContain(words);
    },
  );
}
