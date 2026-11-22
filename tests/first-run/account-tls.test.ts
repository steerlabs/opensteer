import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixtureAuthorityDirectory,
  journeyAccountName,
  journeyAccountSpki,
} from "./account-tls.js";

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

describe("the fixture authority's files, as the guest step makes them", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-authority-files-"));
  const log = execFileSync(
    "/bin/bash",
    [
      path.resolve(import.meta.dirname, "../../scripts/test-vm/fixture-authority-files.sh"),
      directory,
      "Opensteer journey fixture authority",
      journeyAccountName,
    ],
    { encoding: "utf8" },
  );

  it("say what was made, by fingerprint, once the certificate verifies against its authority", () => {
    expect(log).toMatch(/^fixture authority: ca\.pem .*Opensteer journey fixture authority/mu);
    expect(log).toMatch(
      new RegExp(
        `^fixture authority: account\\.pem .*${journeyAccountName.replaceAll(".", "\\.")}`,
        "mu",
      ),
    );
  });

  it("give Chromium the key it is told to accept, as openssl computes it", () => {
    const certificate = readFileSync(path.join(directory, "account.pem"), "utf8");
    // Chromium's own recipe for --ignore-certificate-errors-spki-list.
    const spki = execFileSync(
      "/bin/sh",
      [
        "-c",
        'openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64',
        "spki",
        path.join(directory, "account.pem"),
      ],
      { encoding: "utf8" },
    ).trim();
    expect(journeyAccountSpki(certificate)).toBe(spki);
  });
});
