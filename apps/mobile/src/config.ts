import { mockSubagentScenes, type MockSubagentScene } from "@opensteer/client/mock";
import { bareServiceOrigin } from "@opensteer/core";
import { z } from "zod";

const MobileEnvironmentSchema = z.object({
  EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN: z.string().min(1).max(2_048).optional(),
  EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN: z.string().min(1).max(2_048).optional(),
  EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: z.enum(["development", "preview", "production"]).optional(),
  EXPO_PUBLIC_OPENSTEER_MOCK: z.enum(["0", "1"]).optional(),
  EXPO_PUBLIC_OPENSTEER_MOCK_TEAM: z
    .enum(["admin", "admin-stale", "member", "guest", "suspended", "removed"])
    .optional(),
  EXPO_PUBLIC_OPENSTEER_MOCK_PHONE: z.enum(["away", "needs-update", "no-browser"]).optional(),
  EXPO_PUBLIC_OPENSTEER_MOCK_SUBAGENTS: z.enum(mockSubagentScenes).optional(),
});

export interface MobileConfiguration {
  readonly portalOrigin: string | null;
  /**
   * The Opensteer Account service this build signs in to, or null when it was
   * built without one. Null is a real state, not a missing value: a source
   * build has no Account, and the OAuth manager says so rather than offering a
   * sign-in that cannot complete.
   */
  readonly accountOrigin: string | null;
  /** The development entry that replaces the Host with an in-memory one. */
  readonly mock: boolean;
  /** The team the in-memory Host plays; null is today's Hosts, with no team. */
  readonly mockTeam: NonNullable<
    z.infer<typeof MobileEnvironmentSchema>["EXPO_PUBLIC_OPENSTEER_MOCK_TEAM"]
  > | null;
  /** What becomes of this phone in mock mode once it is added; null for the ordinary phone. */
  readonly mockPhone: "away" | "needs-update" | "no-browser" | null;
  /** One subagent scene of the design, as the web's `?mock-subagents=` seeds it; null for none. */
  readonly mockSubagents: MockSubagentScene | null;
  /**
   * Why this build must not start, or null. It is a state rather than a throw
   * because the answer belongs on screen in a sentence: a build that was asked
   * for something it may not do says so and stops, which is the difference
   * between a refusal and a crash.
   */
  readonly refusal: string | null;
}

/**
 * What this build is allowed to do, as the bundler can prove it.
 *
 * `development` is Metro's `__DEV__`, which is a literal in the bundle: true in
 * a development bundle and false in every bundle `expo export` or a Release
 * native build produces.
 */
export interface MobileBuild {
  readonly development: boolean;
}

/**
 * Everything this build was configured with, read once.
 *
 * Only `EXPO_PUBLIC_*` values exist on a phone, and nothing secret can be kept
 * here. The caller must hand this function an object it built by naming each
 * variable as its own `process.env.EXPO_PUBLIC_…` member: that member
 * expression is what Metro replaces with a literal at bundle time. Passing
 * `process.env` itself compiles, and works in development because the dev
 * server populates that object at runtime — and then silently reads nothing at
 * all in a release build, where there is no runtime environment to read.
 *
 * Mock mode is the one setting that is not the caller's to choose alone. It
 * replaces authentication, the Host and notification registration with
 * simulations, so a distribution build that ran it would be a fake product
 * wearing the real one's name. It is permitted only where the bundle itself
 * proves the build was made to be developed against: `__DEV__`, or a build
 * profile the build command declared. Both are bundle-time literals; neither
 * can be turned on after the fact on a phone.
 */
export function readMobileConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  build: MobileBuild,
): MobileConfiguration {
  const parsed = MobileEnvironmentSchema.parse(environment);
  const accountOrigin = parsed.EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN;
  const profile = parsed.EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE;
  const mockRequested = parsed.EXPO_PUBLIC_OPENSTEER_MOCK === "1";
  const mockAllowed = build.development || profile === "development" || profile === "preview";
  const mockEnabled = mockRequested && mockAllowed;
  return {
    portalOrigin:
      parsed.EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN === undefined
        ? null
        : bareServiceOrigin(parsed.EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN, "Opensteer portal origin"),
    accountOrigin:
      accountOrigin === undefined
        ? null
        : bareServiceOrigin(accountOrigin, "Opensteer Account origin"),
    mock: mockEnabled,
    mockTeam: mockEnabled ? (parsed.EXPO_PUBLIC_OPENSTEER_MOCK_TEAM ?? null) : null,
    mockPhone: mockEnabled ? (parsed.EXPO_PUBLIC_OPENSTEER_MOCK_PHONE ?? null) : null,
    mockSubagents: mockEnabled ? (parsed.EXPO_PUBLIC_OPENSTEER_MOCK_SUBAGENTS ?? null) : null,
    refusal:
      mockRequested && !mockAllowed
        ? "This build was made with Opensteer's mock mode turned on, which only development and preview builds may run. Install a build made without it."
        : null,
  };
}
