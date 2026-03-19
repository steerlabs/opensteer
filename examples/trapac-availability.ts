import { Opensteer } from "../packages/opensteer/src/index.js";

const PAGE_URL =
  "https://losangeles.trapac.com/quick-check/?terminal=LAX&transaction=availability";
const AJAX_URL = "https://losangeles.trapac.com/wp-admin/admin-ajax.php";
const RECAPTCHA_SITE_KEY = "6LfCy7gUAAAAAHSPtJRrJIVQKeKQt_hrYbGSIpuF";

function parseTrapacPayload(value: unknown): { code?: string; html?: string } {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as { code?: string; html?: string };
    } catch {
      return {};
    }
  }
  if (value !== null && typeof value === "object") {
    return value as { code?: string; html?: string };
  }
  return {};
}

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "trapac-availability",
    rootDir: process.cwd(),
    browser: {
      headless: false,
    },
  });

  try {
    await opensteer.open(PAGE_URL);

    const token = String(
      await opensteer.evaluate({
        script: `async () => {
          await new Promise((resolve) => grecaptcha.ready(resolve));
          return grecaptcha.execute("${RECAPTCHA_SITE_KEY}", { action: "quick_check" });
        }`,
      }),
    );

    const body = new URLSearchParams({
      action: "trapac_transaction",
      "recaptcha-token": token,
      terminal: "LAX",
      transaction: "availability",
      containers: "ONEU0618124",
      container: "",
      booking: "",
      email: "",
      equipment_type: "CT",
      services: "",
      from_date: "2026-03-18",
      to_date: "2026-04-18",
    }).toString();

    const response = await opensteer.rawRequest({
      transport: "page-eval-http",
      url: AJAX_URL,
      method: "POST",
      headers: [
        { name: "Accept", value: "application/json, text/javascript, */*; q=0.01" },
        {
          name: "Content-Type",
          value: "application/x-www-form-urlencoded; charset=UTF-8",
        },
        { name: "X-Requested-With", value: "XMLHttpRequest" },
        { name: "Referer", value: PAGE_URL },
      ],
      body: {
        text: body,
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      },
    });

    const payload = parseTrapacPayload(response.data);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: response.response.status,
          code: payload.code ?? null,
          htmlPreview: payload.html?.slice(0, 1200) ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await opensteer.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
