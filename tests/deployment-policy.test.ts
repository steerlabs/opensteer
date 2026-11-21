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
  "packages/client/src/computers/devices-screen.ts": {
    counts: { "input.homeKind": 1, "fact.kind": 1 },
    reason:
      "The Home configuration identifies its physical host form, independently of Deployment policy.",
  },
  "apps/web/src/components/devices/home-facts.tsx": {
    counts: { "home.kind": 1 },
    reason: "The server facts row is selected by the projected Home kind.",
  },
  "apps/mobile/src/screens/device-page.tsx": {
    counts: { homeKind: 1 },
    reason: "A Device page chooses its server address display from the projected Home kind.",
  },
  "apps/mobile/src/screens/apps.tsx": {
    counts: { "app.kind": 1 },
    reason:
      "The app content kind selects HTML or server lifecycle controls, not Deployment policy.",
  },
  "apps/web/src/components/apps/apps-page.tsx": {
    counts: { "deleting.kind": 1, "app.kind": 1 },
    reason:
      "The app content kind selects server deletion copy and lifecycle controls, not Deployment policy.",
  },
  "apps/mobile/src/markdown/reference-link.tsx": {
    counts: { "navigation.context.kind": 2 },
    reason:
      "A reference's render scope says whether its words have a Home to open them in, not Deployment policy.",
  },
  "apps/host/src/runtime/machines.ts": {
    counts: { "runner.device?.form": 1 },
    reason: "The runner hardware form labels a headless device, not a Deployment.",
  },
  "apps/mobile/src/screens/devices-model.ts": {
    counts: { "machine.kind": 2 },
    reason: "Device presentation kind selects a hardware label and icon, not Deployment policy.",
  },
  "apps/web/src/components/devices/add-device-dialog.tsx": {
    counts: { choice: 2 },
    reason: "The add-device choice selects headless enrollment, not a Deployment kind.",
  },
  "apps/web/src/components/devices/devices-page.tsx": {
    counts: { "machine.kind": 1 },
    reason: "Device presentation kind labels headless hardware, not a Deployment.",
  },
  "apps/control-plane/src/database/store.ts": {
    counts: { "shape.data.document.deploymentShape.kind": 1 },
    reason:
      "A team server a previous release listed is left out of the Account's places; the signed shape decides it.",
  },
  "packages/browser-source-wire/src/frozen/personal-access-route.ts": {
    counts: {
      "authority.deploymentShape.kind": 1,
    },
    reason:
      "A frozen copy of what shipped extensions verify; it cannot call the evolving policy and must never change.",
  },
  "apps/desktop/src/bridge/methods/web-links.ts": {
    counts: {
      "selected.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/host/src/browser/saved-logins.ts": {
    counts: {
      "prior.payload.scope": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/host/src/browser/password-sign-in-service.ts": {
    counts: {
      "request.payload.scope": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/host/src/devices/computer-app-approval-service.ts": {
    counts: {
      "request.kind": 3,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },

  "apps/web/src/main.tsx": {
    counts: { mockHome: 1 },
    reason:
      "The web entry chooses its app from signed discovery and cached kind. The mock Home comparison only selects a local visual fixture.",
  },
  "apps/mobile/src/screens/add-deployment.tsx": {
    counts: {
      "props.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/mobile/src/thread/integration-connect-sheet.tsx": {
    counts: {
      "nextCard.form": 1,
      "card.primary?.kind": 1,
      step: 2,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/web/src/components/computers/device-art.tsx": {
    counts: {
      glyph: 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/web/src/components/first-run/setup-page.tsx": {
    counts: {
      "desktopDeployment?.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/web/src/components/places/place-menu.tsx": {
    counts: {
      "row.kind": 1,
    },
    reason: "The computer switcher reads each row's own kind, not Deployment policy.",
  },
  "apps/web/src/components/settings/copy.ts": {
    counts: {
      "input.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/web/src/components/thread-integration-action.tsx": {
    counts: {
      "card.primary.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "apps/web/src/desktop/desktop-app.tsx": {
    counts: {
      presentation: 1,
      "selected.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/client/src/connections/connection-resolver.ts": {
    counts: {
      "connection.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/client/src/connections/deployment-catalog.ts": {
    counts: { "record.kind": 1, shape: 1 },
    reason:
      "A catalog row a previous release saved for a team server is left out by its retired kind before the catalog parses.",
  },
  "packages/client/src/integrations/computer-app-approval.ts": {
    counts: {
      "review.request.kind": 1,
      "request.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/client/src/mock/mock-host-client.ts": {
    counts: {
      "request.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/client/src/react/use-thread-server-approvals.ts": {
    counts: {
      "request.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/database/src/deployment-store.ts": {
    counts: {
      "input.deploymentShape.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/database/src/machine-ownership.ts": {
    counts: {
      "deployment.deploymentShape.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/database/src/private-resource-owner.ts": {
    counts: {
      "owner.deploymentShape.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/database/src/device-inventory-store.ts": {
    counts: { "device?.form": 1 },
    reason: "Classifying a Runner’s physical server form is not a Deployment-kind decision.",
  },
  "packages/database/src/runner-store.ts": {
    counts: {
      "deployment.deploymentShape.kind": 1,
      "deployment?.deploymentShape.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "packages/integration-core/src/computer-app-setup.ts": {
    counts: {
      "request.kind": 1,
    },
    reason: "The comparison reads a resource's own kind, not Deployment policy.",
  },
  "scripts/setup-local.ts": {
    counts: { value: 1 },
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
};

const sqlExceptions: Record<
  string,
  { reason: string; decisions: Record<string, Record<string, number>> }
> = {
  "packages/database/src/baseline-schema.ts": {
    reason:
      "Fresh schema keeps the shapes earlier releases wrote (migrations are expand-only), and the Account directory lists who signs in: the personal owner, or members of a shape no release serves any more.",
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
    reason: "The sole lineage carries every Home; the migrator makes no kind decisions.",
    decisions: {},
  },
};

const policyFiles = execFileSync(
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
      existsSync(path.join(repositoryRoot, file)) &&
      file !== "packages/core/src/deployment-policy.ts",
  );

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
  it.each(policyFiles)(
    "is a tripwire for ordinary Deployment-kind comparisons outside named exceptions: %s",
    (file) => {
      const violations: string[] = [];
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
      expect(violations).toEqual([]);
    },
  );

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
