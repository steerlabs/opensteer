/** Host-owned watcher also works when an app has no queries or its JavaScript fails. */
import * as page from "../contracts/page-names.ts";
const install = () => {
  const context = document.getElementById(page.contextElement)?.textContent;
  if (!context) return;
  const pinned: unknown = JSON.parse(context);
  if (typeof pinned !== "object" || pinned === null || !("version" in pinned)) return;
  const version = pinned.version;
  if (typeof version !== "string" || version.length === 0) return;
  const stream = new EventSource(page.versionPath);
  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    stream.close();
    location.reload();
  };
  stream.addEventListener("version", (event) => {
    const current: unknown = JSON.parse(event.data);
    if (
      typeof current === "object" &&
      current !== null &&
      "version" in current &&
      (current.version === null || typeof current.version === "string") &&
      current.version !== version
    )
      reload();
  });
  stream.addEventListener("revoked", reload);
  window.addEventListener(page.deploymentEvent, reload);
  window.addEventListener("pagehide", () => stream.close(), { once: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) reload();
  });
};

install();

export {};
