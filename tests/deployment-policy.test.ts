import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  kindComparisons,
  sqlKindDecisionInventory,
  comparisonCounts,
} from "./deployment-policy.test-support.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const clientPolicyDerivations: Record<string, { count: number; reason: string }> = {};
const exceptions: Record<string, { counts: Record<string, number>; reason: string }> = {
  "apps/control-plane/src/database/store.ts": {
    counts: {
      "team.data.document.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/control-plane/src/portal/pages.ts": {
    counts: {
      "input.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/desktop/src/bridge/methods/web-links.ts": {
    counts: {
      "selected.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/desktop/src/connections/deployment-access-service.ts": {
    counts: {
      "deployment.kind": 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/desktop/src/connections/host-transport.ts": {
    counts: {
      "connection.authority.document.deploymentShape.kind": 1,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request.",
  },
  "apps/desktop/src/supervisor/local-runner-authority.ts": {
    counts: {
      "connection.authority.document.deploymentShape.kind": 1,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request.",
  },
  "apps/host/src/browser/browser-source-service.ts": {
    counts: {
      "prior.payload.scope": 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/host/src/browser/password-sign-in-service.ts": {
    counts: {
      "request.payload.scope": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/host/src/integrations/computer-app-approval-service.ts": {
    counts: {
      "request.kind": 3,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/host/src/integrations/integration-service.ts": {
    counts: {
      requestedAvailability: 3,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/host/src/server/host-api-registration.ts": {
    counts: {
      "options.kind": 2,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request.",
  },
  "apps/host/src/team-links/discovery.ts": {
    counts: {
      behind: 1,
      "descriptor.kind": 1,
      "document.deploymentShape.kind": 1,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request.",
  },
  "apps/host/src/team-links/service.ts": {
    counts: {
      "error?.details?.behind": 2,
    },
    reason: "The service validates its durable Personal or team authority before acting.",
  },
  "apps/host/src/team/services.ts": {
    counts: {
      "options.kind": 1,
      "durable.deploymentShape.kind": 1,
    },
    reason: "The service validates its durable Personal or team authority before acting.",
  },
  "apps/mobile/src/app.tsx": {
    counts: {
      "outcome.kind": 2,
    },
    reason: "Navigation selects a verified team deep-link destination rather than a Personal task.",
  },
  "apps/mobile/src/client/deployment-credentials.ts": {
    counts: { "connection.kind": 3 },
    reason: "Personal sessions and team OAuth credentials are distinct credential families.",
  },
  "apps/mobile/src/client/mock-mode.ts": {
    counts: { "input.kind": 1 },
    reason: "Mock catalog bootstrap methods follow the declared Personal or team identity.",
  },
  "apps/web/src/main.tsx": {
    counts: { remembered: 3, awaitasked: 1 },
    reason:
      "The per-origin web entry chooses its app from signed discovery and cached deployment kind.",
  },
  "apps/mobile/src/client/deployment-rows.ts": {
    counts: {
      "connection.kind": 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/mobile/src/client/mobile-client.ts": {
    counts: {
      "connection.kind": 4,
      "connection?.kind": 1,
      "connection.authority.document.deploymentShape.kind": 1,
    },
    reason: "Credential and attention reads distinguish personal computers from team sessions.",
  },
  "apps/mobile/src/notifications/notification-routing.ts": {
    counts: {
      "destination.kind": 2,
    },
    reason: "A team notice destination is distinct from the currently visible Personal task.",
  },
  "apps/mobile/src/screens/add-deployment.tsx": {
    counts: {
      "props.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/mobile/src/team/mobile-teams.ts": {
    counts: {
      "verified.discovery.deploymentShape.kind": 1,
    },
    reason: "Team-link admission verifies the signed discovery kind before accepting the team.",
  },
  "apps/mobile/src/thread/integration-connect-sheet.tsx": {
    counts: {
      "nextCard.form": 1,
      "card.primary?.kind": 1,
      step: 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/add-deployment.tsx": {
    counts: {
      choice: 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/computers/device-art.tsx": {
    counts: {
      glyph: 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/first-run/setup-page.tsx": {
    counts: {
      "desktopDeployment?.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/home/needs-you.tsx": {
    counts: {
      "item.where.kind": 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/onboarding.tsx": {
    counts: {
      "config.deployment.kind": 1,
      kind: 2,
    },
    reason:
      "The sign-in door names and describes a team server or this computer; it grants nothing.",
  },
  "apps/web/src/components/places/place-menu.tsx": {
    counts: {
      "row.kind": 1,
    },
    reason:
      "The computer switcher lists personal Deployments; a team server is the team switch, not a computer.",
  },
  "apps/web/src/components/settings/copy.ts": {
    counts: {
      "input.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/components/thread-integration-action.tsx": {
    counts: {
      "card.primary.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/desktop/desktop-app.tsx": {
    counts: {
      presentation: 1,
      "selected.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "apps/web/src/desktop/places.ts": {
    counts: {
      "deployment.kind": 3,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/auth/native-oauth.ts": {
    counts: {
      "connection.kind": 3,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/connections/connection-resolver.ts": {
    counts: {
      "connection.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/connections/deployment-catalog.ts": {
    counts: {
      "deployment.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/connections/host-transport.ts": {
    counts: {
      "this.#expectedKind": 1,
      deploymentKind: 1,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request.",
  },
  "packages/client/src/connections/private-deployment-connection.ts": {
    counts: {
      "parsed.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/host/host-api-client.ts": {
    counts: {
      "options.kind": 2,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/integrations/computer-app-approval.ts": {
    counts: {
      "review.request.kind": 1,
      "request.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/integrations/connect-selection.ts": {
    counts: {
      "application?.availability": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/mock/mock-host-client.ts": {
    counts: {
      "request.kind": 1,
      availability: 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/client/src/react/use-thread-server-approvals.ts": {
    counts: {
      "request.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/database/src/deployment-store.ts": {
    counts: {
      "input.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/database/src/machine-ownership.ts": {
    counts: {
      "deployment.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/database/src/personal-team-links-store.ts": {
    counts: {
      "String(link.authorityEnvelope.updateRequiredBy)": 1,
    },
    reason: "The service validates its durable Personal or team authority before acting.",
  },
  "packages/database/src/private-resource-owner.ts": {
    counts: {
      "owner.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/database/src/runner-store.ts": {
    counts: {
      "deployment.deploymentShape.kind": 1,
      "deployment?.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/deployment-authority/src/authority.ts": {
    counts: {
      kind: 3,
      "parsed.data.kind": 1,
    },
    reason:
      "Transport pins deployment kind and negotiates the independent protocol before admitting a request; only team peers negotiate a version window.",
  },
  "packages/control-plane-protocol/src/hosted-teams.ts": {
    counts: {
      slug: 1,
    },
    reason:
      "Reserved hosted-team addresses include words like team and personal; the check reads an address, not a Deployment kind.",
  },
  "packages/harness/src/types.ts": {
    counts: {
      "runner.deploymentKind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/identity/src/identity-service.ts": {
    counts: {
      "deployment.deploymentShape.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/integration-core/src/models.ts": {
    counts: {
      "request.kind": 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "packages/protocol/src/deployment-status.ts": {
    counts: {
      kind: 1,
    },
    reason: "The boundary distinguishes team data from personal resource scope.",
  },
  "scripts/bench-mobile-network.ts": {
    counts: { "values.seed!": 1 },
    reason: "Benchmark seed labels include team; this is not a Deployment authority decision.",
  },
  "scripts/dev.ts": {
    counts: {
      kind: 3,
      deploymentShape: 2,
      "environment.OPENSTEER_DEPLOYMENT_KIND": 2,
    },
    reason:
      "Configuration admits only the supported deployment kind and selects the services that can start.",
  },
  "scripts/setup-local.ts": {
    counts: {
      value: 2,
    },
    reason:
      "Configuration admits only the supported deployment kind and selects the services that can start.",
  },
  "scripts/smoke-desktop-release-profile.ts": {
    counts: {
      "entry.kind": 1,
    },
    reason:
      "Configuration admits only the supported deployment kind and selects the services that can start.",
  },
  "scripts/verify-team-deployment.mjs": {
    counts: {
      "host.environment?.OPENSTEER_DEPLOYMENT_KIND": 1,
    },
    reason:
      "Configuration admits only the supported deployment kind and selects the services that can start.",
  },
};

const sqlExceptions: Record<
  string,
  { reason: string; decisions: Record<string, Record<string, number>> }
> = {
  "packages/database/src/baseline-schema.ts": {
    reason:
      "Fresh schema validates exactly the two supported deployment shapes, and the Account directory lists who signs in: the personal owner or active team members. Services are composed by deploymentPolicy.",
    decisions: {
      "baseline/deployments_shape": {
        'deployment_shape in (\'{"kind":"personal"}\'::jsonb, \'{"kind":"team"}\'::jsonb))': 1,
      },
      "baseline/opensteer_refresh_account_directory_user": {
        "d.deployment_shape->>'kind'='personal' and u.id=(": 1,
        "d.deployment_shape->>'kind'='team' and exists (": 1,
      },
    },
  },
  "packages/database/src/migrations.ts": {
    reason:
      "The sole lineage is shared by personal and team; the migrator makes no kind decisions.",
    decisions: {},
  },
};

describe("deployment policy boundary", () => {
  it("requires a named exception for a new SQL migration decision", () => {
    const current = readFileSync(
      path.join(repositoryRoot, "packages/database/src/migrations.ts"),
      "utf8",
    );
    expect(sqlKindDecisionInventory(current)).toEqual(
      sqlExceptions["packages/database/src/migrations.ts"]!.decisions,
    );
    const added =
      current +
      `\nexport const unlistedMigration: Migration = { up: async () => sql\`select * from deployments where deployment_shape->>'kind' = 'server'\` };`;
    expect(sqlKindDecisionInventory(added)).not.toEqual(
      sqlExceptions["packages/database/src/migrations.ts"]!.decisions,
    );
  });
  it.each([
    "deployment_shape->>'kind' = 'server'",
    "'server' = deployment_shape->>'kind'",
    "'personal' = (deployment_shape->>'kind')",
    "deployment_shape->>'mode' in ('personal', 'development')",
    "workspace_profile->>'mode' = 'cloud'",
    "deployment_shape['kind'] = '\"server\"'::jsonb",
    "(deployment_shape #>> '{kind}') = 'server'",
    "jsonb_extract_path_text(deployment_shape, 'kind') = 'server'",
  ])("detects a stored-kind decision added by a migration: %s", (predicate) => {
    expect(
      kindComparisons("migration.sql", `select * from deployments where ${predicate};`),
    ).not.toEqual([]);
  });
  it.each([
    'shape["kind"] === "personal"',
    'shape.kind === "team"',
    '["personal", "team"].includes(shape.kind)',
    String.raw`shape.kind === "\u0070ersonal"`,
    String.raw`shape.kind === "\x70ersonal"`,
    "shape.kind === `personal`",
    'shape.kind === ("personal" as const)',
    'const kinds = { personal: "personal" }; shape.kind === kinds.personal',
    'const kinds = { personal: "personal" } as const; shape.kind === kinds.personal',
    'const kinds = { deployment: { personal: "personal" } }; shape.kind === kinds.deployment.personal',
    'const personalKind = "personal"; const kind = shape.kind; kind === personalKind',
    '["personal", "server"].includes(shape.kind)',
    'new Set(["personal"]).has(shape.kind)',
    'const kinds = ["personal", "server"]; isOneOf(shape["kind"], kinds)',
    'switch (shape.kind) { case "other": { work(); } break; case "personal": work(); }',
  ])("detects indirect kind decisions: %s", (source) => {
    expect(kindComparisons("fixture.ts", source)).not.toEqual([]);
  });

  it("counts every use of an exempt expression", () => {
    expect(
      kindComparisons("fixture.ts", 'shape.kind === "personal"; shape.kind === "personal"'),
    ).toHaveLength(2);
    expect(
      comparisonCounts(
        kindComparisons("fixture.ts", 'shape.kind === "personal"; shape.kind === "personal"'),
      ),
    ).not.toEqual({ "shape.kind": 1 });
  });
  it("does not build a syntax tree without a possible kind comparison", () => {
    expect(kindComparisons("fixture.ts", 'const kind: = "personal";')).toEqual([]);
  });
  it("is a tripwire for ordinary Deployment-kind comparisons outside named exceptions", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.mjs",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(
        (file) =>
          /^(apps|packages|scripts)\//u.test(file) &&
          !file.includes(".test.") &&
          !file.includes(".test-support.") &&
          !file.includes("/test-support/") &&
          !file.includes("/test-fixtures/") &&
          existsSync(path.join(repositoryRoot, file)),
      );
    const violations: string[] = [];
    for (const file of files) {
      if (file === "packages/core/src/deployment-policy.ts") continue;
      const text = readFileSync(path.join(repositoryRoot, file), "utf8");
      if (/^(?:apps\/(?:web|mobile|desktop)\/src|packages\/client\/src)\//u.test(file)) {
        const expected = clientPolicyDerivations[file]?.count ?? 0;
        if (
          [...text.matchAll(/\bdeploymentPolicy\s*\(/gu)].length !== expected ||
          (expected === 0 &&
            /import\s*\{[^}]*\b(?:deploymentPolicy|deploymentSupportsSharing|localWorkspaceNamespace)\b[^}]*\}\s*from\s*["']@opensteer\/core["']/u.test(
              text,
            ))
        )
          violations.push(
            `${file}: clients must read the Host projection; derivations need a named compatibility or local-authority exception`,
          );
      }
      if (sqlExceptions[file])
        expect(
          sqlKindDecisionInventory(text),
          `${file}: schema SQL needs a named policy exception`,
        ).toEqual(sqlExceptions[file]!.decisions);
      const comparisons = file.endsWith(".sql") ? [] : kindComparisons(file, text);
      const actual = comparisonCounts(comparisons);
      const expected = exceptions[file]?.counts ?? {};
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        violations.push(
          `${file}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
        );
    }
    expect(violations).toEqual([]);
  });

  it("finds direct, aliased, reversed and switch comparisons without matching comments", () => {
    expect(
      kindComparisons(
        "sample.ts",
        `
      const alias = deployment.shape.kind;
      if (alias === "personal") run();
      if ("server" !== shape.kind) stop();
      switch (deploymentKind) { case "server": break; }
      // kind === "personal"
    `,
      ),
    ).toEqual(["alias", "shape.kind", "deploymentKind"]);
  });
});
