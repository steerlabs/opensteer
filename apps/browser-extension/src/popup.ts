import { browserSiteDomain } from "@opensteer/browser-profile/source-state";
import {
  StatusSchema,
  askWorker,
  type ConnectionState,
  type ConnectionView,
  type Status,
  type UiRequest,
} from "./messages.js";
import { h, hostOf, icon, relativeTime, requireElement } from "./ui.js";

const root = requireElement<HTMLElement>("#popup");
let current: Status | null = null;
let confirming: string | null = null;
let problem: string | null = null;
let lastRendered = "";

const stateLabels: Record<ConnectionState, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting…", tone: "wait" },
  ended: { label: "Disconnected by Opensteer", tone: "bad" },
  offline: { label: "Offline — Chrome keeps trying", tone: "idle" },
  "route-changed": { label: "Reconnect needed", tone: "warn" },
  "update-required": { label: "Extension update needed", tone: "warn" },
  "host-outdated": { label: "Opensteer update needed", tone: "warn" },
};

function settingsUrl(connection: ConnectionView): string {
  return new URL("/settings/chrome", connection.origin).href;
}

async function openOpensteer(connection: ConnectionView): Promise<void> {
  await chrome.tabs.create({ url: settingsUrl(connection) });
  window.close();
}

async function act(request: UiRequest): Promise<void> {
  root.setAttribute("aria-busy", "true");
  const result = await askWorker(request, StatusSchema);
  root.setAttribute("aria-busy", "false");
  if (result.ok) {
    current = result.value;
    problem = null;
  } else {
    problem = "Chrome couldn't make that change. Try again.";
  }
  render(true);
}

function button(
  classes: string,
  label: string,
  onClick: () => void,
  attributes: Record<string, string> = {},
  glyph?: Parameters<typeof icon>[0],
): HTMLButtonElement {
  const element = h(`button.${classes}` as "button", { type: "button", ...attributes });
  if (glyph) element.append(icon(glyph));
  element.append(label);
  element.addEventListener("click", onClick);
  return element;
}

function statusLabel(state: ConnectionState): HTMLElement {
  const { label, tone } = stateLabels[state];
  return h(
    "span.status",
    { "data-tone": tone, role: "status" },
    h("span.status__dot", { "aria-hidden": "true" }),
    label,
  );
}

function fix(connection: ConnectionView): HTMLElement | null {
  const name = connection.deploymentName;
  const key = connection.sourceId;
  switch (connection.state) {
    case "connected":
    case "connecting":
      return null;
    case "offline":
      return h(
        "div.notice",
        {},
        icon("globe"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `Chrome can't reach ${name}. Make sure Opensteer is running on that computer.`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small",
              "Try now",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
              "reload",
            ),
          ),
        ),
      );
    case "update-required":
      return h(
        "div.notice.notice--warn",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `Update the Opensteer extension: download it from ${name}, replace the folder you installed, then choose Reload on Opensteer in chrome://extensions.`,
          ),
          h(
            "div.notice__actions",
            {},
            h(
              "a.btn.btn--small.btn--primary",
              {
                href: new URL("/browser-extension.zip", connection.origin).href,
                target: "_blank",
                "data-key": `download:${key}`,
              },
              icon("download"),
              "Download update",
            ),
            button(
              "btn.btn--small.btn--ghost",
              "Try again",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
            ),
          ),
        ),
      );
    case "host-outdated":
      // Downloading from an older Opensteer would install an older extension.
      return h(
        "div.notice.notice--warn",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            `This Opensteer needs an update before Chrome can connect. Update Opensteer on the computer that runs ${name}, then choose Try again.`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small",
              "Try again",
              () => void act({ sourceId: key, type: "ui.retry" }),
              { "data-key": `retry:${key}` },
              "reload",
            ),
          ),
        ),
      );
    case "route-changed":
    case "ended":
      return h(
        `div.notice.${connection.state === "ended" ? "notice--bad" : "notice--warn"}` as "div",
        {},
        icon("alert-circle"),
        h(
          "div.notice__body",
          {},
          h(
            "p",
            {},
            connection.state === "ended"
              ? `${name} disconnected this Chrome. To use it again, open Settings → Chrome in Opensteer and choose Connect Chrome.`
              : `${name} moved to a new address. Open Settings → Chrome in Opensteer and choose Connect Chrome.`,
          ),
          h(
            "div.notice__actions",
            {},
            button(
              "btn.btn--small.btn--primary",
              "Open Opensteer",
              () => void openOpensteer(connection),
              { "data-key": `fix:${key}` },
              "external-link",
            ),
          ),
        ),
      );
  }
}

function budgetNotice(connection: ConnectionView): HTMLElement | null {
  const { budget } = connection;
  if (budget.used < budget.limit) return null;
  let until: string | null = null;
  if (budget.nextAt) {
    const at = new Date(budget.nextAt);
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    until = at.toDateString() === new Date().toDateString() ? time : `tomorrow at ${time}`;
  }
  return h(
    "div.notice.notice--warn",
    {},
    icon("alert-circle"),
    h(
      "div.notice__body",
      {},
      h(
        "p",
        {},
        h("strong", {}, `${budget.limit} new sites shared today.`),
        ` ${connection.deploymentName} can't use another new site${until ? ` until ${until}` : ""} unless you allow more.`,
      ),
      h(
        "div.notice__actions",
        {},
        button(
          "btn.btn--small",
          "Allow more today",
          () => void act({ sourceId: connection.sourceId, type: "ui.budget.reset" }),
          { "data-key": `budget:${connection.sourceId}` },
        ),
      ),
    ),
  );
}

function siteRow(connection: ConnectionView, site: ConnectionView["sites"][number]): HTMLElement {
  let host: string;
  try {
    host = browserSiteDomain(site.site);
  } catch {
    host = hostOf(site.site);
  }
  const key = `${site.stopped ? "share" : "stop"}:${connection.sourceId}:${site.site}`;
  return h(
    "li.site",
    { "data-stopped": site.stopped },
    h("span.site__glyph", { "aria-hidden": "true" }, host.charAt(0)),
    h(
      "span.site__text",
      {},
      h("span.site__host", {}, host),
      h(
        "span.site__meta",
        {},
        site.stopped ? "Sharing stopped" : `Shared ${relativeTime(site.lastSharedAt)}`,
      ),
    ),
    site.stopped
      ? button(
          "site__action.site__action--share",
          "Share again",
          () => void act({ site: site.site, sourceId: connection.sourceId, type: "ui.site.share" }),
          { "aria-label": `Share ${host} again`, "data-key": key },
        )
      : button(
          "site__action",
          "Stop sharing",
          () => void act({ site: site.site, sourceId: connection.sourceId, type: "ui.site.stop" }),
          { "aria-label": `Stop sharing ${host}`, "data-key": key },
        ),
  );
}

function actions(connection: ConnectionView): HTMLElement {
  const key = connection.sourceId;
  if (confirming === key) {
    return h(
      "div.confirm",
      { role: "group", "aria-label": `Disconnect from ${connection.deploymentName}` },
      h(
        "p",
        {},
        h("strong", {}, `Disconnect Chrome from ${connection.deploymentName}?`),
        connection.state === "connected"
          ? ` ${connection.deploymentName} removes this Chrome too. Agents there can't use your Chrome sign-ins until you connect again.`
          : " Agents there can't use your Chrome sign-ins until you connect again. Opensteer will show this Chrome as offline until you remove it there.",
      ),
      h(
        "div.confirm__actions",
        {},
        button(
          "btn.btn--small.btn--danger",
          "Disconnect",
          () => {
            confirming = null;
            void act({ sourceId: key, type: "ui.disconnect" });
          },
          { "data-key": `confirm:${key}` },
          "log-out",
        ),
        button(
          "btn.btn--small.btn--ghost",
          "Cancel",
          () => {
            confirming = null;
            render(true, `disconnect:${key}`);
          },
          { "data-key": `cancel:${key}` },
        ),
      ),
    );
  }
  // When the fix above is already Open Opensteer, the footer does not repeat it.
  const fixOpens = connection.state === "ended" || connection.state === "route-changed";
  return h(
    "div.deployment__actions",
    {},
    fixOpens
      ? h("span")
      : button(
          "btn.btn--small",
          "Open Opensteer",
          () => void openOpensteer(connection),
          { "data-key": `open:${key}` },
          "external-link",
        ),
    button(
      "btn.btn--small.btn--ghost",
      "Disconnect",
      () => {
        confirming = key;
        render(true, `confirm:${key}`);
      },
      { "data-key": `disconnect:${key}` },
    ),
  );
}

function deployment(connection: ConnectionView): HTMLElement {
  const sharing = connection.sites.filter((site) => !site.stopped).length;
  return h(
    "section.deployment",
    { "aria-label": connection.deploymentName },
    h(
      "div.deployment__head",
      {},
      h("h2.deployment__name", {}, connection.deploymentName),
      h("span.deployment__origin.mono", { title: connection.origin }, hostOf(connection.origin)),
      statusLabel(connection.state),
    ),
    fix(connection),
    budgetNotice(connection),
    h(
      "div.sites",
      {},
      h(
        "div.sites__head",
        {},
        h("h3.sites__title", {}, "Shared sites"),
        connection.sites.length ? h("span", {}, `${sharing} sharing`) : null,
      ),
      connection.sites.length
        ? h(
            "ul.sites__list",
            {
              tabindex: connection.sites.length > 6 ? "0" : undefined,
              "aria-label": "Shared sites",
            },
            ...connection.sites.map((site) => siteRow(connection, site)),
          )
        : h(
            "p.sites__empty",
            {},
            `None yet. A site appears here the first time ${connection.deploymentName} uses your sign-in for it.`,
          ),
    ),
    actions(connection),
  );
}

function empty(): HTMLElement {
  return h(
    "section.empty",
    {},
    h("p.empty__lead", {}, "Let your agents use the sites you're signed in to here."),
    h(
      "p.empty__text",
      {},
      "Nothing is shared until you allow a site in Opensteer, and Chrome tells you each time a new site is shared.",
    ),
    h(
      "p.empty__step",
      {},
      "In Opensteer, open ",
      h("strong", {}, "Settings → Chrome"),
      " and choose ",
      h("strong", {}, "Connect Chrome"),
      ".",
    ),
  );
}

function render(force = false, focusKey?: string): void {
  if (!current) return;
  const active = focusKey ?? (document.activeElement as HTMLElement | null)?.dataset.key;
  const children: HTMLElement[] = current.connections.length
    ? current.connections.map(deployment)
    : [empty()];
  if (problem) {
    children.unshift(
      h("p.notice.notice--bad.popup__problem", { role: "alert" }, icon("alert-circle"), problem),
    );
  }
  // Only what the popup shows decides whether it is redrawn. A status that
  // changes nothing visible, such as another reconnect attempt, must not
  // replace the button under the person's cursor.
  const markup = children.map((child) => child.outerHTML).join("");
  if (!force && markup === lastRendered) return;
  lastRendered = markup;
  root.replaceChildren(...children);
  root.setAttribute("aria-busy", "false");
  if (active) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.focus();
}

async function refresh(): Promise<void> {
  const result = await askWorker({ type: "ui.status" }, StatusSchema);
  if (result.ok) {
    current = result.value;
    render();
  } else if (!current) {
    current = { connections: [] };
    problem = "Opensteer's extension isn't responding. Close this and try again.";
    render(true);
  }
}

void refresh();
setInterval(() => void refresh(), 1_500);
