import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import {
  BrowserSourceIdSchema,
  RequestSchema,
  WorkspaceIdSchema,
  createId,
  type Request,
} from "@opensteer/core";
import type {
  BrowserSignInOutcome,
  BrowserSiteGrant,
  BrowserSourceInspection,
  BrowserSourcePairing,
  BrowserSourcesState,
  BrowserSourceStatus,
  BrowserSourceSummary,
} from "@opensteer/protocol/browser-sources";

/**
 * Chrome sign-ins in the preview. Three Chrome profiles — two online, one
 * offline — and a fixed table of what each has for a handful of sites, so every
 * state of the sign-in card and the browser toolbar can be reached by site:
 *
 *   github.com  one Chrome signed in          linear.app  two signed in: choose
 *   notion.so   sharing stopped in Chrome     figma.com   Chrome blocks the site
 *   x.com       Chrome's daily limit          stripe.com  only the offline Chrome
 *
 * Any other site is signed out everywhere. Pairing adds a Chrome a moment
 * later, the way the extension would after its connect tab.
 */
const macName = "Chrome on Mac";
const workName = "Chrome · Work profile";
const studioName = "Chrome on Studio";

const siteTable: Readonly<Record<string, Readonly<Record<string, BrowserSourceStatus>>>> = {
  "https://figma.com": { [macName]: "chrome-blocked" },
  "https://github.com": { [macName]: "available" },
  "https://linear.app": { [macName]: "available", [workName]: "available" },
  "https://notion.so": { [macName]: "stopped" },
  "https://stripe.com": { [studioName]: "available" },
  "https://x.com": { [macName]: "limit" },
};

const mainWorkspaceId = WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001");
const launchWorkspaceId = WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000002");

export class MockChromeSignIns {
  #sources: BrowserSourceSummary[];
  #sites: BrowserSiteGrant[];
  #pairingTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
    const at = (hoursAgo: number) => new Date(now().getTime() - hoursAgo * 3_600_000).toISOString();
    const mac = BrowserSourceIdSchema.parse("bsr_00000000-0000-4000-8000-000000000001");
    const work = BrowserSourceIdSchema.parse("bsr_00000000-0000-4000-8000-000000000002");
    this.#sources = [
      { connected: true, createdAt: at(240), id: mac, lastSeenAt: at(0), name: macName },
      {
        connected: true,
        createdAt: at(120),
        id: work,
        lastSeenAt: at(0),
        name: workName,
      },
      {
        connected: false,
        createdAt: at(400),
        id: BrowserSourceIdSchema.parse("bsr_00000000-0000-4000-8000-000000000003"),
        lastSeenAt: at(3),
        name: studioName,
      },
    ];
    this.#sites = [
      {
        createdAt: at(200),
        lastSignedInAt: at(26),
        preferredSourceId: mac,
        site: "https://github.com",
        workspaceId: mainWorkspaceId,
      },
      {
        createdAt: at(100),
        lastSignedInAt: at(50),
        preferredSourceId: mac,
        site: "https://github.com",
        workspaceId: launchWorkspaceId,
      },
      {
        createdAt: at(30),
        lastSignedInAt: null,
        preferredSourceId: null,
        site: "https://linear.app",
        workspaceId: launchWorkspaceId,
      },
      // Main last used the Work profile for linear.app, so it is offered first there.
      {
        createdAt: at(20),
        lastSignedInAt: at(4),
        preferredSourceId: work,
        site: "https://linear.app",
        workspaceId: mainWorkspaceId,
      },
    ];
  }

  state(): BrowserSourcesState {
    return { sites: [...this.#sites], sources: [...this.#sources] };
  }

  inspect(url: string): BrowserSourceInspection {
    const site = browserSiteFromUrl(url);
    return {
      candidates: this.#sources.map((source) => ({
        name: source.name,
        sourceId: source.id,
        status: source.connected ? this.#status(site, source.name) : "offline",
      })),
      site,
    };
  }

  pair(origin: string): BrowserSourcePairing {
    const expiresAt = new Date(this.#now().getTime() + 15 * 60_000).toISOString();
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    this.#pairingTimer = setTimeout(() => {
      this.#pairingTimer = null;
      const count = this.#sources.length;
      this.#sources = [
        ...this.#sources,
        {
          connected: true,
          createdAt: this.#now().toISOString(),
          id: BrowserSourceIdSchema.parse(createId("browserSource")),
          lastSeenAt: this.#now().toISOString(),
          name: count === 0 ? macName : `Chrome on Mac (${count + 1})`,
        },
      ];
    }, 3_500);
    return {
      destinations: [{ origin, remote: false }],
      expiresAt,
      invitation: `opensteer-browser-source:preview-${crypto.randomUUID()}`,
    };
  }

  rename(sourceId: string, name: string): void {
    this.#sources = this.#sources.map((source) =>
      source.id === sourceId ? { ...source, name } : source,
    );
  }

  revoke(sourceId: string): void {
    this.#sources = this.#sources.filter((source) => source.id !== sourceId);
    this.#sites = this.#sites.map((grant) =>
      grant.preferredSourceId === sourceId ? { ...grant, preferredSourceId: null } : grant,
    );
  }

  removeSite(workspaceId: string, site: string): void {
    this.#sites = this.#sites.filter(
      (grant) => !(grant.workspaceId === workspaceId && grant.site === site),
    );
  }

  /** Allowing a Request remembers the site before Chrome has answered. */
  remember(workspaceId: string, site: string, sourceId: string): void {
    const existing = this.#sites.find(
      (grant) => grant.workspaceId === workspaceId && grant.site === site,
    );
    const preferredSourceId = BrowserSourceIdSchema.parse(sourceId);
    this.#sites = existing
      ? this.#sites.map((grant) => (grant === existing ? { ...grant, preferredSourceId } : grant))
      : [
          ...this.#sites,
          {
            createdAt: this.#now().toISOString(),
            lastSignedInAt: null,
            preferredSourceId,
            site,
            workspaceId: WorkspaceIdSchema.parse(workspaceId),
          },
        ];
  }

  /** The owner's path: sign in now with one Chrome, or say why not. */
  signIn(input: {
    readonly profileName: string | null;
    readonly site: string;
    readonly sourceId: string | null;
    readonly workspaceId: string;
  }): BrowserSignInOutcome {
    const inspection = this.inspect(input.site);
    const problem = (
      problem: Extract<BrowserSignInOutcome, { status: "problem" }>["problem"],
      sourceName: string | null = null,
    ): BrowserSignInOutcome => ({ problem, site: inspection.site, sourceName, status: "problem" });
    if (inspection.candidates.length === 0) return problem("no-chrome");
    const preferred = this.#sites.find(
      (grant) => grant.workspaceId === input.workspaceId && grant.site === inspection.site,
    )?.preferredSourceId;
    const available = inspection.candidates.filter((candidate) => candidate.status === "available");
    const chosen =
      inspection.candidates.find((candidate) => candidate.sourceId === input.sourceId) ??
      available.find((candidate) => candidate.sourceId === preferred) ??
      (available.length === 1 ? available[0] : undefined);
    if (!chosen) {
      if (available.length > 1) return problem("choose-source");
      for (const candidate of inspection.candidates) {
        if (candidate.status !== "offline" && candidate.status !== "available") {
          return problem(candidate.status, candidate.name);
        }
      }
      return problem("chrome-offline", inspection.candidates[0]?.name ?? null);
    }
    if (chosen.status === "offline") return problem("chrome-offline", chosen.name);
    if (chosen.status !== "available") return problem(chosen.status, chosen.name);
    const now = this.#now().toISOString();
    const existing = this.#sites.find(
      (grant) => grant.workspaceId === input.workspaceId && grant.site === inspection.site,
    );
    this.#sites = existing
      ? this.#sites.map((grant) =>
          grant === existing
            ? { ...grant, lastSignedInAt: now, preferredSourceId: chosen.sourceId }
            : grant,
        )
      : [
          ...this.#sites,
          {
            createdAt: now,
            lastSignedInAt: now,
            preferredSourceId: chosen.sourceId,
            site: inspection.site,
            workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
          },
        ];
    return {
      profileName: input.profileName,
      site: inspection.site,
      sourceName: chosen.name,
      status: "applied",
    };
  }

  #status(site: string, sourceName: string): BrowserSourceStatus {
    return siteTable[site]?.[sourceName] ?? "no-state";
  }
}

/**
 * A pending agent sign-in Request for the preview, on the expenses Thread, so
 * a page can open the card in any of the states the site table above covers.
 */
export function mockBrowserSignInRequest(site: string, index: number): Request {
  const domain = new URL(site).hostname;
  return RequestSchema.parse({
    callId: `mock-sign-in-${index}`,
    cancellationReason: null,
    createdAt: new Date(Date.UTC(2026, 7, 7, 19, 20 + index)).toISOString(),
    id: `req_0192f4a1-5555-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "browser.sign-in",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: "run_00000000-0000-4000-8000-000000000004",
    originatingThreadId: mockSignInThreadId,
    originatingWorkspaceId: mockSignInWorkspaceId,
    payload: {
      kind: "browser.sign-in",
      reason: `Download the August statement from ${domain} to finish the reconciliation.`,
      sessionId: "bss_preview",
      site,
    },
    presentation: {
      kind: "external",
      subject: { id: site, kind: "browser-site" },
      title: `Sign in to ${domain}`,
    },
    requestedBy: "usr_0192f4a1-0000-4000-8000-000000000001",
    requiredActor: "workspace-owner",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: mockSignInWorkspaceId,
  });
}

const mockSignInThreadId = "thr_00000000-0000-4000-8000-000000000004";
const mockSignInWorkspaceId = "wsp_00000000-0000-4000-8000-000000000003";
