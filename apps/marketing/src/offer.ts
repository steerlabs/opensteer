import { cloudComputerPriceLine } from "@opensteer/control-plane-protocol/cloud-computer-copy";

type Plan = Parameters<typeof cloudComputerPriceLine>[0];
const intervals = new Set(["day", "week", "month", "year"]);

/** The plan in the account service's answer, or null for anything this page can't say exactly. */
export function offeredPlan(answer: unknown): Plan | null {
  if (typeof answer !== "object" || answer === null) return null;
  const plan = (answer as { plan?: unknown }).plan;
  if (typeof plan !== "object" || plan === null) return null;
  const { amountMinor, currency, interval } = plan as Record<string, unknown>;
  if (typeof currency !== "string" || !/^[a-z]{3}$/u.test(currency)) return null;
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0)
    return null;
  if (interval !== undefined && (typeof interval !== "string" || !intervals.has(interval)))
    return null;
  return { amountMinor, currency, interval: interval as Plan["interval"] };
}

/** "$29.00 a month · cancel any time", in the same words as the account's own page. */
export function offerLine(plan: Plan): string {
  return `${cloudComputerPriceLine(plan, "en-US").line} · cancel any time`;
}

/**
 * The Cloud Computer card's price, read when the page loads from the account service's public
 * offer: no cookies, no credentials, nothing about the visitor. Missing, late or not ready,
 * the card keeps saying what it already says.
 */
export async function mountOffer(line: HTMLElement | null, timeoutMs = 4_000): Promise<void> {
  const url = line?.dataset["offer"];
  if (!line || !url) return;
  try {
    const response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return;
    const plan = offeredPlan(await response.json());
    if (plan) line.textContent = offerLine(plan);
  } catch {
    // The card already says it is paid monthly.
  }
}
