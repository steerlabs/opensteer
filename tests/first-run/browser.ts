/**
 * The system browser's part of signing in to the Opensteer account, for a journey with no person
 * at the browser: it loads the authorization page the app opened, is sent to the account
 * service's own sign-in page, fills in its App Review form, accepts its consent page and returns
 * where that sends a browser, which is the app's own callback address (macOS would then hand it
 * to the app). Every page and every answer is the account service's; this only does what a
 * browser does with them: follow redirects, keep cookies, send the form's fields and its origin.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface AccountSignInSteps {
  /** Each page the browser was on, in order, by path: the journey's evidence of the route taken. */
  readonly visited: readonly string[];
  /** Where the account service finally sent the browser: the app's callback, with its code. */
  readonly callback: string;
}

interface Answer {
  readonly status: number;
  readonly location: string | null;
  readonly cookies: readonly string[];
  readonly body: string;
}

interface Navigation {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export async function signInAtAccount(input: {
  readonly authorizeUrl: string;
  readonly email: string;
  readonly password: string;
}): Promise<AccountSignInSteps> {
  const account = new URL(input.authorizeUrl).origin;
  const jar = new Map<string, string>();
  const visited: string[] = [];
  let first = true;
  const request = async (url: URL, init: Navigation = {}): Promise<Answer> => {
    const headers: Record<string, string> = {
      ...init.headers,
      // A top-level navigation, as every browser marks one: the account service answers those
      // with redirects and pages, where a script's request gets JSON. (Node's fetch always says
      // it is a script, `sec-fetch-mode: cors`, so a browser's request goes out over node:http.)
      accept: "text/html",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      // The first page is the one the app opened; every later one follows from the account's.
      "sec-fetch-site": first ? "none" : "same-origin",
    };
    first = false;
    if (jar.size > 0)
      headers["cookie"] = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const answer = await navigation(url, init.method ?? "GET", headers, init.body);
    for (const cookie of answer.cookies) {
      const [pair] = cookie.split(";");
      const at = pair!.indexOf("=");
      if (at > 0) jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    visited.push(`${init.method ?? "GET"} ${url.pathname}`);
    return answer;
  };
  /** Follows redirects on the account service until a page answers, or one leaves it. */
  const navigate = async (start: URL, init: Navigation = {}) => {
    let url = start;
    let answer = await request(url, init);
    for (let hop = 0; answer.status >= 300 && answer.status < 400; hop += 1) {
      if (hop > 10) throw new Error("The account service redirected too many times");
      if (!answer.location) throw new Error(`A redirect from ${url.pathname} has no location`);
      url = new URL(answer.location, url);
      if (url.origin !== account) return { left: url, page: null };
      answer = await request(url);
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new Error(`${url.pathname} answered ${answer.status}: ${answer.body}`);
    }
    return { left: null, page: { html: answer.body, url } };
  };
  const submit = (form: { action: URL; fields: URLSearchParams }) =>
    navigate(form.action, {
      body: form.fields.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: account },
      method: "POST",
    });

  const signInPage = await navigate(new URL(input.authorizeUrl));
  if (!signInPage.page) throw new Error("Authorization left the account service before sign-in");
  const signIn = pageForm(signInPage.page, "/sign-in/app-review");
  signIn.fields.set("email", input.email);
  signIn.fields.set("password", input.password);
  const consentPage = await submit(signIn);
  if (!consentPage.page) throw new Error("Signing in left the account service before consent");
  const consent = pageForm(consentPage.page, "/consent");
  consent.fields.set("decision", "accept");
  const done = await submit(consent);
  if (!done.left) throw new Error("Consent did not send the browser back to the app");
  return { callback: done.left.toString(), visited };
}

/** One request as a browser sends it: only the headers given, no redirect followed. */
function navigation(
  url: URL,
  method: "GET" | "POST",
  headers: Readonly<Record<string, string>>,
  body: string | undefined,
): Promise<Answer> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(
      url,
      {
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
        method,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const cookies = incoming.headers["set-cookie"] ?? [];
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            cookies,
            location: incoming.headers.location ?? null,
            status: incoming.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${url.pathname} timed out`)));
    outgoing.end(body);
  });
}

/** A form on a page, found by where it posts, with the values its hidden fields carry. */
export function pageForm(
  page: { readonly html: string; readonly url: URL },
  action: string,
): { action: URL; fields: URLSearchParams } {
  const forms = [...page.html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)];
  const form = forms.find((match) => attribute(match[1]!, "action") === action);
  if (!form) {
    throw new Error(`${page.url.pathname} has no form that posts to ${action}`);
  }
  const fields = new URLSearchParams();
  for (const input of form[2]!.matchAll(/<input\b([^>]*)>/giu)) {
    if (attribute(input[1]!, "type") !== "hidden") continue;
    const name = attribute(input[1]!, "name");
    if (name) fields.set(name, attribute(input[1]!, "value") ?? "");
  }
  return { action: new URL(action, page.url), fields };
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "iu").exec(tag);
  return match ? decodeEntities(match[1]!) : null;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
