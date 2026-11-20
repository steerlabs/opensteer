import { describe, expect, it } from "vitest";
import { harnessChallengeReturnsToLoopback } from "./runner.js";

function browserCode(authorizationUrl: string) {
  return { authorizationUrl, inputPrompt: "Paste the code", kind: "browser-code" } as const;
}
function authorize(redirect: string | null): string {
  const url = new URL("https://accounts.example.test/authorize?client_id=engine");
  if (redirect !== null) url.searchParams.set("redirect_uri", redirect);
  return url.href;
}

describe("harnessChallengeReturnsToLoopback", () => {
  it("is true only for a browser sign-in whose authorization returns to a loopback address", () => {
    for (const redirect of [
      "http://127.0.0.1:51121/oauth-callback",
      "http://localhost:1455/auth/callback",
      "http://[::1]:8085/callback",
    ])
      expect(harnessChallengeReturnsToLoopback(browserCode(authorize(redirect)))).toBe(true);
  });

  it("is false for a sign-in the person can finish on any device", () => {
    for (const challenge of [
      browserCode(authorize("https://platform.example.test/oauth/code/callback")),
      browserCode(authorize(null)),
      browserCode(authorize("not a url")),
      { kind: "device-code", userCode: "ABCD-EFGH", verificationUrl: authorize(null) },
      { inputLabel: "API key", kind: "secret-input" },
    ] as const)
      expect(harnessChallengeReturnsToLoopback(challenge)).toBe(false);
  });
});
