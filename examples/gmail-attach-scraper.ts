import { Opensteer } from "../packages/opensteer/src/index.js";

const sessionName = process.env.OPENSTEER_SESSION_NAME ?? "gmail-real";
const rootDir = process.env.OPENSTEER_ROOT_DIR ?? process.cwd();

async function main(): Promise<void> {
  const opensteer = Opensteer.attach({
    name: sessionName,
    rootDir,
  });

  try {
    const attached = await opensteer.open();
    const navigated = await opensteer.goto("https://mail.google.com/mail/u/0/#inbox");
    if (navigated.url.startsWith("https://accounts.google.com/")) {
      throw new Error(
        "The attached browser is not signed into Gmail. Sign in in the existing browser window, then rerun this script.",
      );
    }

    const clickedSelector = await clickFirstMatchingSelector(opensteer, [
      '[role="main"] table[role="grid"] tr[role="row"]',
      '[role="main"] tr.zA',
      '[role="main"] [data-legacy-message-id]',
    ]);

    const subject = await extractFirstMatchingSelector(opensteer, "gmail message subject", [
      "h2.hP",
      '[role="main"] h2',
    ]);
    const sender = await extractFirstMatchingSelector(opensteer, "gmail message sender", [
      "span[email].gD",
      ".gD[email]",
      "h3 span[email]",
    ]);
    const body = await extractFirstMatchingSelector(opensteer, "gmail message body", [
      "div.a3s",
      "div.ii.gt",
      '[role="main"] .a3s',
    ]);

    console.log(
      JSON.stringify(
        {
          sessionName,
          attached,
          navigated,
          clickedSelector,
          message: {
            subject,
            sender,
            body,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await opensteer.disconnect();
  }
}

async function clickFirstMatchingSelector(
  opensteer: Opensteer,
  selectors: readonly string[],
): Promise<string> {
  for (const selector of selectors) {
    try {
      await opensteer.click({
        selector,
        description: "first gmail email",
      });
      return selector;
    } catch {
      continue;
    }
  }

  throw new Error("Could not find a Gmail inbox row to click in the attached browser session.");
}

async function extractFirstMatchingSelector(
  opensteer: Opensteer,
  description: string,
  selectors: readonly string[],
): Promise<string> {
  for (const selector of selectors) {
    try {
      const result = await opensteer.extract({
        description: `${description}:${selector}`,
        schema: {
          value: { selector },
        },
      });
      const value = result.value;
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Could not extract ${description} from the opened Gmail message.`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
