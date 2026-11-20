import {
  CloudComputerListResponseSchema,
  CloudComputerReasonCodeSchema,
  CloudComputerViewSchema,
  MyOrganizationsResponseSchema,
  WorkHomeResponseSchema,
  accountCloudComputerPath,
  accountOrganizationsPath,
  cloudComputerReasonNext,
  cloudComputerReasonSentence,
  accountCloudComputerResumePath,
  accountCloudComputerSuspendPath,
  accountCloudComputersPath,
} from "@opensteer/control-plane-protocol";
import type {
  DesktopCloudComputerActInput,
  DesktopCloudComputerActResult,
  DesktopCloudComputerFailure,
  DesktopCloudComputerReadResult,
  DesktopWorkHome,
} from "@opensteer/protocol/desktop";
import { AccountRequestError } from "./account-deployment-directory.js";
import { cloudWords } from "../computers/cloud-computer-copy.js";
import { classifyClientFailure } from "./operation-error.js";

/**
 * Where an app reads and changes the person's Cloud Computers: main's Account client on
 * desktop, the phone's own, or a mock. Every answer is a result, so the same failures
 * reach a screen however many processes the call crossed.
 */
export interface CloudComputerAccount {
  read(): Promise<DesktopCloudComputerReadResult>;
  act(input: DesktopCloudComputerActInput): Promise<DesktopCloudComputerActResult>;
}

/** The app's one Account client, as this feature needs it. */
export interface AccountRequestTransport {
  accountRequest(
    path: string,
    input: { readonly method: "DELETE" | "GET" | "POST" | "PUT"; readonly body?: string },
  ): Promise<unknown>;
}

const unreachable = cloudWords("cloud.account.unreachable");
const signedOut = cloudWords("cloud.account.signedOut");
const unavailable = cloudWords("cloud.account.unavailable");

/** How an Account call failed, in the words a screen shows. */
export function cloudComputerFailure(error: unknown): DesktopCloudComputerFailure {
  if (error instanceof AccountRequestError) {
    if (error.status === 401) return { kind: "signed-out", message: signedOut };
    if (error.status === 429 || error.status >= 500)
      return { kind: "unreachable", message: unreachable };
    return { kind: "refused", message: refusalWords(error).slice(0, 1000) };
  }
  if (error instanceof Error && /isn't available yet|isn’t available yet/u.test(error.message))
    return { kind: "unavailable", message: unavailable };
  const failure = classifyClientFailure(error);
  if (failure.code === "unauthorized") return { kind: "signed-out", message: signedOut };
  return { kind: "unreachable", message: unreachable };
}

/** The Account's Cloud Computer API over the app's existing Account client. */
export class AccountCloudComputerClient implements CloudComputerAccount {
  readonly #transport: AccountRequestTransport | null;

  constructor(options: { readonly transport: AccountRequestTransport | null }) {
    this.#transport = options.transport;
  }

  async read(): Promise<DesktopCloudComputerReadResult> {
    const transport = this.#transport;
    if (!transport) return { ok: false, failure: { kind: "unavailable", message: unavailable } };
    try {
      const body = await transport.accountRequest(accountCloudComputersPath, { method: "GET" });
      const data = CloudComputerListResponseSchema.parse(body);
      const work = await workHomes(transport);
      return { ok: true, data, ...(work === null ? {} : { work }) };
    } catch (error) {
      return { ok: false, failure: cloudComputerFailure(error) };
    }
  }

  async act(input: DesktopCloudComputerActInput): Promise<DesktopCloudComputerActResult> {
    const transport = this.#transport;
    if (!transport) return { ok: false, failure: { kind: "unavailable", message: unavailable } };
    try {
      const body = await transport.accountRequest(
        input.action === "suspend"
          ? accountCloudComputerSuspendPath(input.id)
          : input.action === "resume"
            ? accountCloudComputerResumePath(input.id)
            : accountCloudComputerPath(input.id),
        input.action === "delete"
          ? { method: "DELETE", body: JSON.stringify({ confirmation: input.confirmation }) }
          : { method: "POST", body: "{}" },
      );
      return { ok: true, data: CloudComputerViewSchema.parse(body) };
    } catch (error) {
      return { ok: false, failure: cloudComputerFailure(error) };
    }
  }
}

/**
 * The Account's refusal in the app's own words where it has them for the reason code,
 * else the Account's sentence as given.
 */
function refusalWords(error: AccountRequestError): string {
  const reason = CloudComputerReasonCodeSchema.safeParse(error.reason);
  if (!reason.success) return error.message;
  const sentence = cloudComputerReasonSentence(reason.data) ?? error.message;
  const next = cloudComputerReasonNext(reason.data);
  return next ? `${sentence} ${next}` : sentence;
}

/**
 * The work Homes organizations assigned this person, each with its Cloud Computer when
 * the Account shows it. Null when the organization reads fail: the personal Cloud
 * Computer still shows, and nothing is said about work that could not be read.
 */
async function workHomes(transport: AccountRequestTransport): Promise<DesktopWorkHome[] | null> {
  try {
    const mine = MyOrganizationsResponseSchema.parse(
      await transport.accountRequest(accountOrganizationsPath, { method: "GET" }),
    );
    const homes = await Promise.all(
      mine.organizations.map(async (organization) =>
        WorkHomeResponseSchema.parse(
          await transport.accountRequest(
            `${accountOrganizationsPath}/${encodeURIComponent(organization.id)}/work-home`,
            { method: "GET" },
          ),
        ),
      ),
    );
    return await Promise.all(
      homes.flatMap((home) =>
        home === null
          ? []
          : [
              (async (): Promise<DesktopWorkHome> => {
                try {
                  const computer = CloudComputerViewSchema.parse(
                    await transport.accountRequest(
                      accountCloudComputerPath(home.assignment.computerId),
                      { method: "GET" },
                    ),
                  );
                  return { home, computer };
                } catch {
                  return { home, computer: null };
                }
              })(),
            ],
      ),
    );
  } catch {
    return null;
  }
}
