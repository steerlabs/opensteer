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
const exceptionGroups = {
  displayAlias: {
    "apps/control-plane/src/portal/pages.ts": {
      counts: {
        "input.kind": 1,
      },
      reason: "Deployment display alias selects an icon.",
    },
    "apps/mobile/src/client/deployment-rows.ts": {
      counts: {
        "connection.kind": 1,
      },
      reason: "Catalog display alias labels the computer.",
    },
    "apps/web/src/components/onboarding.tsx": {
      counts: {
        kind: 2,
      },
      reason: "Deployment display alias selects onboarding copy.",
    },
    "apps/web/src/components/settings/copy.ts": {
      counts: {
        "input.kind": 3,
      },
      reason: "Deployment display alias selects descriptive copy.",
    },
    "apps/web/src/components/settings/primitives.tsx": {
      counts: {
        kind: 1,
      },
      reason: "Deployment display alias selects a glyph.",
    },
    "apps/web/src/computers-visual.tsx": {
      counts: {
        "scenario.kind": 2,
      },
      reason: "Visual fixture constructs a display alias.",
    },
    "apps/web/src/desktop/places.ts": {
      counts: {
        "deployment.kind": 3,
      },
      reason: "Catalog display alias selects labels and sort order.",
    },
    "apps/web/src/desktop/preview-bootstrap.ts": {
      counts: {
        "selected.kind": 6,
      },
      reason: "Desktop preview fixture constructs the mock Host response from a display alias.",
    },
    "packages/protocol/src/deployment-status.ts": {
      counts: {
        kind: 1,
      },
      reason: "Deployment display alias selects a label.",
    },
    "scripts/smoke-desktop-release-profile.ts": {
      counts: {
        "entry.kind": 1,
      },
      reason: "Release smoke locates the Personal display entry.",
    },
  },
  beforeBootstrapTransport: {
    "apps/desktop/src/connections/deployment-access-service.ts": {
      counts: {
        "deployment.kind": 2,
      },
      reason:
        "Catalog display alias selects route-status diagnostics before bootstrap is reachable.",
    },
    "apps/mobile/src/client/mobile-client.ts": {
      counts: {
        "connection.kind": 1,
      },
      reason: "Catalog display alias selects the Personal login transport before bootstrap.",
    },
    "apps/mobile/src/screens/add-deployment.tsx": {
      counts: {
        "props.kind": 1,
      },
      reason: "Add-place presentation choice, before a Host has been selected.",
    },
    "apps/web/src/components/add-deployment.tsx": {
      counts: {
        choice: 1,
      },
      reason: "Add-place presentation choice, before Host attachment.",
    },
    "apps/web/src/components/first-run/setup-page.tsx": {
      counts: {
        "desktopDeployment?.kind": 1,
      },
      reason: "Desktop display alias locates setup on the supervised computer before bootstrap.",
    },
    "apps/web/src/desktop/desktop-app.tsx": {
      counts: {
        presentation: 1,
        "selected.kind": 1,
      },
      reason: "Desktop place presentation and local setup before bootstrap.",
    },
    "packages/client/src/connections/connection-resolver.ts": {
      counts: {
        "connection.kind": 1,
      },
      reason: "Catalog display alias chooses a signed route before bootstrap.",
    },
    "packages/client/src/connections/deployment-catalog.ts": {
      counts: {
        "deployment.kind": 1,
      },
      reason:
        "Display alias is checked against signed identity during Personal route admission, before bootstrap.",
    },
  },
  otherDiscriminator: {
    "apps/host/src/integrations/computer-app-approval-service.ts": {
      counts: {
        "request.kind": 3,
      },
      reason: "Integration approval request discriminator, not a Deployment kind.",
    },
    "apps/host/src/integrations/integration-service.ts": {
      counts: {
        requestedAvailability: 3,
      },
      reason: "Integration availability, not a Deployment kind.",
    },
    "apps/mobile/src/screens/settings-model.ts": {
      counts: {
        "home.kind": 2,
      },
      reason: "ComputersHome presentation discriminator, already projected from Host policy.",
    },
    "apps/mobile/src/thread/integration-connect-sheet.tsx": {
      counts: {
        "nextCard.form": 1,
        "card.primary?.kind": 1,
        step: 2,
      },
      reason: "Integration connection form, not Deployment kind.",
    },
    "apps/web/src/components/computers-page.tsx": {
      counts: {
        "home.kind": 2,
      },
      reason: "ComputersHome presentation discriminator, already projected from Host policy.",
    },
    "apps/web/src/components/computers/device-art.tsx": {
      counts: {
        glyph: 1,
      },
      reason: "Device icon name, not Deployment kind.",
    },
    "apps/web/src/components/thread-integration-action.tsx": {
      counts: {
        "card.primary.kind": 1,
      },
      reason: "Integration action discriminator, not Deployment kind.",
    },
    "apps/web/src/passwords-visual.tsx": {
      counts: {
        settingsState: 2,
      },
      reason: "Visual scenario discriminator, not Deployment kind.",
    },
    "packages/client/src/integrations/computer-app-approval.ts": {
      counts: {
        "review.request.kind": 1,
        "request.kind": 1,
      },
      reason: "Integration approval discriminator, not Deployment kind.",
    },
    "packages/client/src/integrations/connect-selection.ts": {
      counts: {
        "application?.availability": 1,
      },
      reason: "Integration availability, not Deployment kind.",
    },
    "packages/client/src/mock/mock-host-client.ts": {
      counts: {
        "request.kind": 1,
        availability: 1,
      },
      reason: "Mock integration approval and availability discriminators.",
    },
    "packages/client/src/react/use-thread-server-approvals.ts": {
      counts: {
        "request.kind": 1,
      },
      reason: "Integration approval discriminator, not Deployment kind.",
    },
    "packages/integration-core/src/models.ts": {
      counts: {
        "request.kind": 1,
      },
      reason: "Integration approval discriminator, not Deployment kind.",
    },
    "scripts/verify-browser-deployment.mjs": {
      counts: {
        "runner.environment?.OPENSTEER_DEPLOYMENT_KIND": 1,
      },
      reason: "Deployment verification asserts the configured fixture, not runtime policy.",
    },
  },
};
const exceptions: Record<string, { counts: Record<string, number>; reason: string }> =
  Object.assign({}, ...Object.values(exceptionGroups));

const sqlExceptions: Record<
  string,
  { reason: string; decisions: Record<string, Record<string, number>> }
> = {
  "packages/database/src/baseline-schema.ts": {
    reason:
      "Historical installed SQL; replace each named function, shape constraint or conversion through a new cutover migration, never by editing history.",
    decisions: {
      "baseline/public.opensteer_user_can_execute_environment": {
        "deployment.deployment_shape->>'tenancy' <> 'single-user'": 1,
        "deployment.deployment_shape->>'tenancy' = 'single-user'": 1,
      },
      "baseline/deployments_shape_check": {
        "deployment_shape->>'ownerEstablishment' = ANY (ARRAY['self-claim', 'enrollment'])": 1,
        "deployment_shape->>'tenancy' = ANY (ARRAY['single-user', 'multi-user'])": 1,
      },
    },
  },
  "packages/database/src/migrations.ts": {
    reason:
      "Historical installed SQL; replace each named function, shape constraint or conversion through a new cutover migration, never by editing history.",
    decisions: {
      "ownedNativeOAuthCallbackMigration/deployments_shape_check": {
        "deployment_shape->>'ownerEstablishment' = any (array['self-claim', 'enrollment'])": 1,
        "deployment_shape->>'tenancy' = any (array['single-user', 'multi-user'])": 1,
      },
      "ownedNativeOAuthCallbackMigration/public.opensteer_user_can_execute_environment": {
        "deployment.deployment_shape->>'tenancy' <> 'single-user'": 1,
        "deployment.deployment_shape->>'tenancy' = 'single-user'": 1,
      },
      "deploymentKindAndHostIdentityMigration/deployment-shape-conversion": {
        "deployment_shape->>'tenancy' = 'single-user' then 'personal'": 1,
      },
      "deploymentKindAndHostIdentityMigration/deployments_shape_check": {
        "deployment_shape->>'kind' = any (array['personal', 'server'])": 1,
      },
      "deploymentKindAndHostIdentityMigration/public.opensteer_user_can_execute_environment": {
        "deployment.deployment_shape->>'kind' = 'server'": 1,
        "deployment.deployment_shape->>'kind' = 'personal'": 1,
      },
      "runnerOwnedLocalWorkspacesMigration/deployments_shape_check": {
        "deployment_shape->>'kind' = any (array['personal', 'server'])": 1,
      },
    },
  },
};

describe("deployment policy boundary", () => {
  it("requires a named exception for a new SQL migration decision", () => {
    const historical = readFileSync(
      path.join(repositoryRoot, "packages/database/src/migrations.ts"),
      "utf8",
    );
    expect(sqlKindDecisionInventory(historical)).toEqual(
      sqlExceptions["packages/database/src/migrations.ts"]!.decisions,
    );
    const added =
      historical +
      `\nexport const unlistedMigration: Migration = { up: async () => sql\`select * from deployments where deployment_shape->>'kind' = 'server'\` };`;
    expect(sqlKindDecisionInventory(added)).not.toEqual(
      sqlExceptions["packages/database/src/migrations.ts"]!.decisions,
    );
  });
  it.each([
    "deployment_shape->>'kind' = 'server'",
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
  it("compares Deployment kinds only in the policy, with explicit non-policy exceptions", () => {
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
        "*.sql",
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
      if (
        /^(?:apps\/(?:web|mobile)\/src|packages\/client\/src)\//u.test(file) &&
        file !== "packages/client/src/mock/mock-host-client.ts" &&
        file !== "packages/client/src/host/deployment-policy.ts" &&
        (/\bdeploymentPolicy\s*\(/u.test(text) ||
          /import\s*\{[^}]*\b(?:deploymentPolicy|deploymentSupportsSharing|localWorkspaceNamespace)\b[^}]*\}\s*from\s*["']@opensteer\/core["']/u.test(
            text,
          ))
      )
        violations.push(`${file}: clients must read the Host projection`);
      expect(
        sqlKindDecisionInventory(text),
        `${file}: installed SQL needs a named cutover exception`,
      ).toEqual(sqlExceptions[file]?.decisions ?? {});
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
