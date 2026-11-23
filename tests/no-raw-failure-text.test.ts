import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A caught failure's own text (`error.message`) never reaches a person's screen: what a person
 * reads for a failed call to a Home is decided in one place,
 * `packages/client/src/host/failure-text.ts` (`homeFailureText`). This scans the client, web,
 * phone and desktop sources for a caught failure's `.message` used as a value (drawn, stored for
 * drawing, or returned as words), leaving out what only inspects it, wraps it in another error,
 * or logs it. Each file still allowed one says why, and how many it holds.
 *
 * It also sees a caught failure drawn whole: a `message` destructured from it, `String(error)`,
 * `${error}` and `error.toString()`.
 *
 * What it still cannot see:
 * - a failure held under any other name (`failure.message`, `problem.message`, `thrown`), and
 *   `reason`, which here names a sentence as often as a failure, in the whole-failure forms;
 * - a member access split over lines (`error\n  .message`), or a line that also logs or throws;
 * - a helper outside the four roots that returns a failure's text (`safeMessage(error)`);
 * - whether an allowed file's reason is still true: each entry is read by a person.
 */
/** Why a file may still use a failure's own text, by kind. */
const reasons = {
  account:
    "The Opensteer account service's refusal, not a Home call; its error bodies are written for the person.",
  signin:
    "Sign-in: the text of this app's own sign-in errors (OAuth and session exchange), never a Home refusal's.",
  wire: "Wire translation: turns a failure into an RPC error or an error object; what a person reads is decided later by homeFailureText or the feedback layer.",
  mock: "The preview Home answering as a Home does: it builds refusals and records answers, it draws nothing.",
  run: "A Run's own outcome, which the Home stores as the Run's data and the transcript shows as that Run's result.",
  desktop:
    "The desktop app's own local processes and helpers (no Home call); these sentences are written by this app or sent to another process.",
  local: "A local failure this app wrote as a sentence for the person (its own error class).",
  dev: "Development only: a preview harness or the development error overlay.",
  helper:
    "The phone's agent helper process: the text goes back to the Home as the operation's failure, not to a screen.",
  inspection:
    "The Home's channel inspection issue, written as a sentence for the person (the same text the account shows as its status detail).",
  words: "Builds a refusal for failureWords, which decides the words.",
} as const;

const allowed: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  "apps/desktop/src/app/background-mode.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/browser/editing-engine-journey.ts": {
    count: 1,
    reason: "A journey's evidence file, written for whoever reads the run, never drawn.",
  },
  "apps/desktop/src/app/local-stop.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/app/menu-bar.ts": { count: 2, reason: reasons.desktop },
  "apps/desktop/src/app/quit-routing.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/bridge/methods/passwords.ts": { count: 2, reason: reasons.desktop },
  "apps/desktop/src/computer-app-setup-guide.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/computer-use/computer-use-bridge-server.ts": {
    count: 1,
    reason: reasons.desktop,
  },
  "apps/desktop/src/computer-use/helper-client.ts": { count: 2, reason: reasons.desktop },
  "apps/desktop/src/connections/desktop-host-api.ts": { count: 1, reason: reasons.wire },
  "apps/desktop/src/connections/host-transport.ts": { count: 1, reason: reasons.wire },
  "apps/desktop/src/connections/personal-remote-access.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/connections/remote-administration-executor.ts": {
    count: 2,
    reason: reasons.desktop,
  },
  "apps/desktop/src/main.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/passwords/broker-client.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/passwords/login-authority.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/passwords/passwords-service.ts": { count: 3, reason: reasons.desktop },
  "apps/desktop/src/signed-helpers/signed-helper.ts": { count: 2, reason: reasons.desktop },
  "apps/desktop/src/supervisor/browser-extension-directory.ts": {
    count: 1,
    reason: reasons.desktop,
  },
  "apps/desktop/src/supervisor/cloudflared-connector-supervisor.ts": {
    count: 2,
    reason: reasons.desktop,
  },
  "apps/desktop/src/supervisor/local-runner-service.ts": { count: 1, reason: reasons.desktop },
  "apps/desktop/src/supervisor/personal-deployment-supervisor.ts": {
    count: 2,
    reason: reasons.desktop,
  },
  "apps/desktop/src/supervisor/personal-host-connect-orchestrator.ts": {
    count: 1,
    reason: reasons.desktop,
  },
  "apps/desktop/src/supervisor/personal-user-environment.ts": { count: 1, reason: reasons.desktop },
  "apps/mobile/src/browser/browser-page.tsx": { count: 1, reason: reasons.words },
  "apps/mobile/src/images/image-actions.tsx": { count: 1, reason: reasons.local },
  "apps/mobile/src/phone-browser/agent-helper/entry.ts": { count: 1, reason: reasons.helper },
  "apps/mobile/src/phone-browser/agent-helper/helper.ts": { count: 1, reason: reasons.helper },
  "apps/mobile/src/thread/transcript.tsx": { count: 1, reason: reasons.run },
  "apps/web/src/attachments-visual.tsx": { count: 1, reason: reasons.dev },
  "apps/web/src/components/agent-activity.tsx": { count: 1, reason: reasons.run },
  "apps/web/src/components/devices/add-iphone-dialog.tsx": { count: 1, reason: reasons.desktop },
  "apps/web/src/components/image-actions.tsx": { count: 1, reason: reasons.local },
  "apps/web/src/components/messaging-page.tsx": { count: 1, reason: reasons.inspection },
  "apps/web/src/desktop/desktop-connect-failure.ts": { count: 1, reason: reasons.desktop },
  "apps/web/src/desktop/desktop-preview-bridge.ts": { count: 1, reason: reasons.desktop },
  "apps/web/src/desktop/menu-bar-popover.tsx": { count: 1, reason: reasons.desktop },
  "apps/web/src/main.tsx": { count: 2, reason: reasons.dev },
  "packages/client/src/auth/host-session-exchange.ts": { count: 1, reason: reasons.signin },
  "packages/client/src/auth/host-session.ts": { count: 2, reason: reasons.signin },
  "packages/client/src/auth/host-sign-in-outcome.ts": { count: 1, reason: reasons.signin },
  "packages/client/src/auth/native-oauth.ts": { count: 1, reason: reasons.signin },
  "packages/client/src/connections/account-cloud-computers.ts": {
    count: 3,
    reason: reasons.account,
  },
  "packages/client/src/connections/account-deployment-directory.ts": {
    count: 1,
    reason: reasons.account,
  },
  "packages/client/src/connections/account-notification-devices-client.ts": {
    count: 1,
    reason: reasons.account,
  },
  "packages/client/src/host/agent-activity-model.ts": { count: 1, reason: reasons.run },
  "packages/client/src/host/browser-editing.ts": { count: 1, reason: reasons.local },
  "packages/client/src/host/host-api-client.ts": { count: 2, reason: reasons.wire },
  "packages/client/src/host/host-session-client.ts": { count: 1, reason: reasons.wire },
  "packages/client/src/host/remote-access.ts": { count: 1, reason: reasons.local },
  "packages/client/src/mock/chat-parity.ts": { count: 1, reason: reasons.mock },
  "packages/client/src/mock/mock-host-client.ts": { count: 3, reason: reasons.mock },
};

const roots = ["packages/client/src", "apps/web/src", "apps/mobile/src", "apps/desktop/src"];
/**
 * A caught failure's text (`error.message`), a failed answer's (`result.error.message`), and a
 * validator's issue (`parsed.error.issues[0]?.message`).
 */
const caughtMessage =
  /(^|[^.\w])(error|err|e|reason|cause|caught|exception|ex)\.message\b|\.error\??\.message\b|\.issues\b.*\.message\b/u;
/** A caught failure drawn whole: destructured, stringified or interpolated. */
const caughtWhole =
  /catch \(\{ *message|const \{ *message *\} *= *(error|err|e|cause|caught|exception|ex)\b|String\((error|err|e|cause|caught|exception|ex)\)|\$\{(error|err|e|cause|caught|exception|ex)\}|\b(error|err|e|cause|caught|exception|ex)\.toString\(\)/u;
const notAValue =
  /console\.|log\.(warn|error|info|debug)|logger\.|\.log\(|#log\(|reportError|captureException|\.message\.(includes|startsWith|endsWith|match|test|toLowerCase|length)|\.message [!=]==|new [A-Za-z]*Error\(|throw |cause:/u;

it("puts no caught failure's own text where a person reads it, outside the one function", () => {
  const repository = path.resolve(import.meta.dirname, "..");
  const found = new Map<string, string[]>();
  for (const root of roots)
    for (const file of sources(path.join(repository, root))) {
      const relative = path.relative(repository, file);
      if (relative === "packages/client/src/host/failure-text.ts") continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if ((caughtMessage.test(line) || caughtWhole.test(line)) && !notAValue.test(line))
            found.set(relative, [...(found.get(relative) ?? []), `${index + 1}: ${line.trim()}`]);
        });
    }
  const unexplained = [...found].flatMap(([file, lines]) =>
    allowed[file]?.count === lines.length ? [] : lines.map((line) => `${file}:${line}`),
  );
  const stale = Object.keys(allowed).filter(
    (file) => (found.get(file)?.length ?? 0) !== allowed[file]!.count,
  );
  expect({ unexplained, stale }).toEqual({ unexplained: [], stale: [] });
});

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      yield* sources(full);
    } else if (
      /\.(ts|tsx)$/u.test(entry.name) &&
      !/\.test\.|\.d\.ts$|test-support/u.test(entry.name)
    )
      yield full;
  }
}
