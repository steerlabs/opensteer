import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const exceptions: Record<string, { expressions: readonly string[]; reason: string }> = {
  "apps/control-plane/src/portal/pages.ts": {
    expressions: ["input.kind"],
    reason: "Deployment display alias selects an icon.",
  },
  "apps/desktop/src/bridge/methods/web-links.ts": {
    expressions: ["selected.kind"],
    reason: "Display alias identifies the selected local app link before Host attachment.",
  },
  "apps/desktop/src/connections/deployment-access-service.ts": {
    expressions: ["deployment.kind"],
    reason: "Catalog display alias selects route-status diagnostics before bootstrap is reachable.",
  },
  "apps/host/src/integrations/computer-app-approval-service.ts": {
    expressions: ["request.kind"],
    reason: "Integration approval request discriminator, not a Deployment kind.",
  },
  "apps/host/src/integrations/integration-service.ts": {
    expressions: ["requestedAvailability"],
    reason: "Integration availability, not a Deployment kind.",
  },
  "apps/mobile/src/client/deployment-rows.ts": {
    expressions: ["connection.kind"],
    reason: "Catalog display alias labels the computer.",
  },
  "apps/mobile/src/client/mobile-client.ts": {
    expressions: ["connection.kind"],
    reason: "Catalog display alias selects the Personal login transport before bootstrap.",
  },
  "apps/mobile/src/screens/add-deployment.tsx": {
    expressions: ["props.kind"],
    reason: "Add-place presentation choice, before a Host has been selected.",
  },
  "apps/mobile/src/screens/settings-model.ts": {
    expressions: ["home.kind"],
    reason: "ComputersHome presentation discriminator, already projected from Host policy.",
  },
  "apps/mobile/src/thread/integration-connect-sheet.tsx": {
    expressions: ["nextCard.form", "step"],
    reason: "Integration connection form, not Deployment kind.",
  },
  "apps/web/src/components/add-deployment.tsx": {
    expressions: ["choice"],
    reason: "Add-place presentation choice, before Host attachment.",
  },
  "apps/web/src/components/app-shell.tsx": {
    expressions: ["desktopDeployment.kind", "desktopDeployment?.kind"],
    reason:
      "Desktop display alias locates the locally supervised app and its setup/link transport.",
  },
  "apps/web/src/components/computers-page.tsx": {
    expressions: ["home.kind"],
    reason: "ComputersHome presentation discriminator, already projected from Host policy.",
  },
  "apps/web/src/components/computers/device-art.tsx": {
    expressions: ["glyph"],
    reason: "Device icon name, not Deployment kind.",
  },
  "apps/web/src/components/first-run/setup-page.tsx": {
    expressions: ["desktopDeployment?.kind"],
    reason: "Desktop display alias locates setup on the supervised computer before bootstrap.",
  },
  "apps/web/src/components/home-intro.tsx": {
    expressions: ["desktopDeployment?.kind"],
    reason: "Desktop display alias locates setup on the supervised computer.",
  },
  "apps/web/src/components/onboarding.tsx": {
    expressions: ["kind"],
    reason: "Deployment display alias selects onboarding copy.",
  },
  "apps/web/src/components/passwords-suggestion.tsx": {
    expressions: ["desktopDeployment?.kind"],
    reason: "Desktop display alias locates the native Passwords app.",
  },
  "apps/web/src/components/settings/copy.ts": {
    expressions: ["input.kind"],
    reason: "Deployment display alias selects descriptive copy.",
  },
  "apps/web/src/components/settings/primitives.tsx": {
    expressions: ["kind"],
    reason: "Deployment display alias selects a glyph.",
  },
  "apps/web/src/components/thread-integration-action.tsx": {
    expressions: ["card.primary.kind"],
    reason: "Integration action discriminator, not Deployment kind.",
  },
  "apps/web/src/computers-visual.tsx": {
    expressions: ["scenario.kind"],
    reason: "Visual fixture constructs a display alias.",
  },
  "apps/web/src/desktop/desktop-app.tsx": {
    expressions: ["presentation", "selected.kind"],
    reason: "Desktop place presentation and local setup before bootstrap.",
  },
  "apps/web/src/desktop/places.ts": {
    expressions: ["deployment.kind"],
    reason: "Catalog display alias selects labels and sort order.",
  },
  "apps/web/src/desktop/preview-bootstrap.ts": {
    expressions: ["selected.kind"],
    reason: "Desktop preview fixture constructs the mock Host response from a display alias.",
  },
  "apps/web/src/passwords-visual.tsx": {
    expressions: ["settingsState"],
    reason: "Visual scenario discriminator, not Deployment kind.",
  },
  "packages/client/src/connections/connection-resolver.ts": {
    expressions: ["connection.kind"],
    reason: "Catalog display alias chooses a signed route before bootstrap.",
  },
  "packages/client/src/connections/deployment-catalog.ts": {
    expressions: ["deployment.kind"],
    reason:
      "Display alias is checked against signed identity during Personal route admission, before bootstrap.",
  },
  "packages/client/src/integrations/computer-app-approval.ts": {
    expressions: ["review.request.kind", "request.kind"],
    reason: "Integration approval discriminator, not Deployment kind.",
  },
  "packages/client/src/integrations/connect-selection.ts": {
    expressions: ["application?.availability"],
    reason: "Integration availability, not Deployment kind.",
  },
  "packages/client/src/mock/mock-host-client.ts": {
    expressions: ["request.kind", "availability"],
    reason: "Mock integration approval and availability discriminators.",
  },
  "packages/client/src/react/use-thread-server-approvals.ts": {
    expressions: ["request.kind"],
    reason: "Integration approval discriminator, not Deployment kind.",
  },
  "packages/integration-core/src/models.ts": {
    expressions: ["request.kind"],
    reason: "Integration approval discriminator, not Deployment kind.",
  },
  "packages/protocol/src/deployment-status.ts": {
    expressions: ["kind"],
    reason: "Deployment display alias selects a label.",
  },
  "scripts/smoke-desktop-release-profile.ts": {
    expressions: ["entry.kind"],
    reason: "Release smoke locates the Personal display entry.",
  },
  "scripts/verify-browser-deployment.mjs": {
    expressions: ["runner.environment?.OPENSTEER_DEPLOYMENT_KIND"],
    reason: "Deployment verification asserts the configured fixture, not runtime policy.",
  },
};

function kindComparisons(_file: string, text: string): string[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  const comparisons = [
    ...source.matchAll(
      /(?<![\w$.?])([\w$.?]+)\s*(?:={2,3}|!={1,2})\s*["'](?:personal|server)["']/gu,
    ),
  ].map((match) => match[1]!);
  for (const match of source.matchAll(
    /["'](?:personal|server)["']\s*(?:={2,3}|!={1,2})\s*([\w$.?]+)/gu,
  ))
    comparisons.push(match[1]!);
  for (const match of source.matchAll(/switch\s*\(([^)]+)\)\s*\{([^}]+)\}/gu)) {
    if (/case\s+["'](?:personal|server)["']/u.test(match[2]!)) comparisons.push(match[1]!.trim());
  }
  return [...new Set(comparisons)];
}

describe("deployment policy boundary", () => {
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
        file !== "apps/mobile/src/client/mock-mode.ts" &&
        /\bdeploymentPolicy\s*\(/u.test(text)
      )
        violations.push(`${file}: clients must read the Host projection`);
      const comparisons = kindComparisons(file, text);
      for (const expression of comparisons) {
        if (!exceptions[file]?.expressions.includes(expression))
          violations.push(`${file}: ${expression}`);
      }
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
