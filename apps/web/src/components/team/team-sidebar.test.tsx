// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TeamSide } from "./team-sidebar.js";
import type { TeamConnection } from "./team-models.js";

const states: readonly TeamConnection[] = [
  "online",
  "reconnecting",
  "offline",
  "update-app",
  "update-server",
  "sign-in",
  "removed",
  "left",
];
it.each(states)("keeps an action in the desktop team pane when %s", (connection) => {
  const act = () => {};
  const html = renderToStaticMarkup(
    <TeamSide
      team={{
        id: "team",
        tile: { name: "Acme", color: "blue" },
        connection,
        channels: [],
        dms: [],
      }}
      actions={{
        onOpenChannel: act,
        onBrowseChannels: act,
        onNewMessage: act,
        onRemoveFromSidebar: act,
        onRetry: act,
      }}
    />,
  );
  expect(html).toContain("<button");
  if (connection === "sign-in") expect(html).toContain("Sign in");
  if (connection === "removed" || connection === "left") expect(html).toContain("Remove");
});
