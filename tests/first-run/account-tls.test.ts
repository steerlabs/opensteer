import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureAuthorityDirectory, journeyAccountName } from "./account-tls.js";

/*
 * The journey and the guarded guest step agree on the account service's name and where the
 * fixture authority is written: the step makes them, the journey reads them.
 */

const step = readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/test-vm/fixture-keychain.sh"),
  "utf8",
);

describe("the fixture authority the journey reads", () => {
  it("is where the guest step writes it, under the name it puts on loopback", () => {
    expect(step).toContain(`account_name="${journeyAccountName}"`);
    expect(step).toContain('authority="$HOME/opensteer-job/fixture-authority"');
    expect(fixtureAuthorityDirectory("/Users/admin")).toBe(
      "/Users/admin/opensteer-job/fixture-authority",
    );
    // The step has its files made in that folder, by the script that only writes them.
    expect(step).toContain(
      '/bin/bash "$HOME/opensteer-job/fixture-authority-files.sh" "$authority"',
    );
    const files = readFileSync(
      path.resolve(import.meta.dirname, "../../scripts/test-vm/fixture-authority-files.sh"),
      "utf8",
    );
    for (const file of ["ca.pem", "account.pem", "account.key"])
      expect(files).toContain(`"$directory/${file}"`);
  });
});
