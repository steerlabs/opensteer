/**
 * The one test for "this is an extension's address". A URL or origin that parses (per WHATWG URL
 * rules, stripping ASCII tabs/newlines and leading C0 controls) to the `chrome-extension:` scheme,
 * including inside `view-source:`, `blob:` and `filesystem:` wrappers.
 *
 * Every door through which a connected agent (a standard CDP client, a `browser_use` script, a
 * Run in a connection's lineage) can be given a tab, target, frame, session or script identity, an
 * address or a title, and where the rule is applied there (no extension's target or address is
 * given, and what is outside reads as absent):
 * 1. The router's root events and replies (`portable-session-cdp-router.ts`): one predicate,
 *    `#mayName` (shown and not hidden, its script's root, or a target its own channel is on), for
 *    no-`targetInfo` terminal events, root-level browser events by `targetId` / `frameId`
 *    (`#connectionMayHearBrowserEvent`, which also drops any extension address) and every
 *    target-valued `targetInfo` field (`#projectTargetInfo`, `#confineFrameIds`). Replies:
 *    `Target.getTargets` / `getTargetInfo` project through `#projectTargetInfo`; a script's
 *    `rootTargetId` is its own root; `Target.getBrowserContexts` names none; `createTarget`,
 *    `attachToTarget` and `attachToBrowserTarget` return the connection's own ids.
 * 2. Inside a page session (`connection-extension-isolation.ts`): `observeEvent`, then
 *    `#confineForwarded` for every forwarded event (frames nested in or attached by an extension,
 *    stacks, and any field carrying an extension address or frame); `sanitizeResult`, then
 *    `#withoutExtensionFrames` for replies.
 * 3. The runtime's own commands admitted to a connection (`cdp-command-refusals.ts`,
 *    `connectionOpensteerMethods`; `controller.ts`): `Opensteer.listTabs` (a tab on an extension
 *    page is not listed, nor named as an opener), `Opensteer.resumeTab` (answers as a closed tab,
 *    before the wake and after its load), `Opensteer.fillLogin` / `fillCard` (answer as a missing
 *    page session), `Opensteer.stageFile` (the Browser Session's files: no tab identity).
 * 4. The Home (`apps/host`): its tab store keeps no extension address (`tab-store.ts`
 *    `restoreUrl`, on open and on every navigation), so `tab_list`, `discover`, `browser_use`'s
 *    `pages()`, `tab.open` results and a tab's read-back never carry one; and rule 1's page rule
 *    (`resource-access.ts` `authorizePageAddress`, called by `tab-authority.ts` for every page
 *    target) makes such a row not exist to a connection's lineage. On a shared root and the
 *    fallback path, `browser-service.ts`'s subscription confines a connection's events (its own
 *    sessions only, a tab on an extension page hidden, related ids confined, browser-level events
 *    by known target and no extension address) and drops them after its binding ends or its
 *    Disconnect closes it. A Run's recorded places (`#placeData`) skip an extension's page.
 * 5. Pictures and downloads: a screenshot is pixels of a page the connection holds; in Electron a
 *    connection-controlled page cannot navigate, frame-navigate or redirect to an extension's
 *    address (`electron-browser-launcher.ts`); `Browser.downloadWillBegin` meets door 1 (and the
 *    Host's browser-level rule on a shared root).
 *
 * The same doors keep a page on an address of this Home from every agent, a connected agent's or
 * the person's own: `ThisHomeAddressSet` (`./homeAddress.ts`) lists where.
 */
export function isExtensionUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "chrome-extension:") return true;
    if (
      parsed.protocol === "view-source:" ||
      parsed.protocol === "blob:" ||
      parsed.protocol === "filesystem:"
    )
      return isExtensionUrl(parsed.pathname);
    return false;
  } catch {
    return false;
  }
}
