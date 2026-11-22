import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createServer, request } from "node:https";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAccountTlsAccepted,
  fixtureAuthorityDirectory,
  journeyAccountName,
  journeyAccountSpki,
  journeyAccountTls,
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

/*
 * Run 20261122T221025Z-d20c2ea7: in the guest both certificates came out as CN=placeholder. The
 * guest step runs with SSH's plain PATH, so the script's `openssl` is /usr/bin/openssl (LibreSSL),
 * which takes the subject from the config and ignores -subj; every run here had found Homebrew's
 * OpenSSL first. The leaf's issuer then equals its own subject, and Node's client calls it
 * self-signed. So the files are made here exactly as there, and held to what a client checks.
 */
describe("the fixture authority's files, made with the guest step's PATH", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-authority-guest-"));
  execFileSync(
    "/bin/bash",
    [
      path.resolve(import.meta.dirname, "../../scripts/test-vm/fixture-authority-files.sh"),
      directory,
      "Opensteer journey fixture authority",
      journeyAccountName,
    ],
    { env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: "ignore" },
  );
  const read = (name: string) => readFileSync(path.join(directory, name), "utf8");
  const text = (name: string) =>
    execFileSync(
      "/usr/bin/openssl",
      ["x509", "-in", path.join(directory, name), "-noout", "-text"],
      {
        encoding: "utf8",
      },
    );
  /** A key identifier as `openssl -text` prints it, under its extension's heading. */
  const keyIdentifier = (printed: string, heading: string) =>
    new RegExp(`${heading}:\\s*\\n\\s*(?:keyid:)?([0-9A-F:]+)`, "u").exec(printed)?.[1] ?? null;

  it("names the authority and the account service apart, the leaf issued by the authority", () => {
    const authority = new X509Certificate(read("ca.pem"));
    const leaf = new X509Certificate(read("account.pem"));
    expect(authority.subject).toBe("CN=Opensteer journey fixture authority");
    expect(leaf.subject).toBe(`CN=${journeyAccountName}`);
    expect(leaf.issuer).toBe(authority.subject);
    expect(leaf.subjectAltName).toBe(`DNS:${journeyAccountName}`);
    expect(leaf.checkIssued(authority)).toBe(true);
    expect(leaf.verify(authority.publicKey)).toBe(true);
  });

  it("gives the leaf the authority's key identifier", () => {
    const authorityKey = keyIdentifier(text("ca.pem"), "X509v3 Subject Key Identifier");
    expect(authorityKey).not.toBeNull();
    expect(keyIdentifier(text("account.pem"), "X509v3 Authority Key Identifier")).toBe(
      authorityKey,
    );
  });

  // What the journey's own client does: a TLS handshake with a server holding the pair, trusting
  // only the authority.
  it("is accepted by Node's client trusting only the authority, under the account host's name", async () => {
    const server = createServer({ cert: read("account.pem"), key: read("account.key") }, (_q, a) =>
      a.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const answer = await new Promise<string>((resolve) => {
        const outgoing = request(
          {
            ca: read("ca.pem"),
            host: "127.0.0.1",
            path: "/",
            port,
            servername: journeyAccountName,
          },
          (incoming) => {
            incoming.resume();
            resolve(String(incoming.statusCode));
          },
        );
        outgoing.on("error", (error) => resolve(error.message));
        outgoing.end();
      });
      expect(answer).toBe("200");
    } finally {
      server.close();
    }
  });
});

describe("the journey's own check of the fixture's files, before it launches anything", () => {
  const make = (script: string) => {
    const directory = mkdtempSync(path.join(tmpdir(), "first-run-authority-check-"));
    execFileSync(
      "/bin/bash",
      [script, directory, "Opensteer journey fixture authority", journeyAccountName],
      {
        env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: "ignore",
      },
    );
    return journeyAccountTls(directory)!;
  };

  it("passes the files the guest step makes", async () => {
    await expect(
      assertAccountTlsAccepted(
        make(path.resolve(import.meta.dirname, "../../scripts/test-vm/fixture-authority-files.sh")),
      ),
    ).resolves.toBeUndefined();
  });

  // The script as run 20261122T221025Z-d20c2ea7 had it: both certificates "CN=placeholder".
  it("stops on the pair the guest had, with Node's reason", async () => {
    const old = path.join(mkdtempSync(path.join(tmpdir(), "first-run-old-script-")), "old.sh");
    writeFileSync(
      old,
      execFileSync("git", ["show", "5d197dfbc:scripts/test-vm/fixture-authority-files.sh"], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
      }),
    );
    await expect(assertAccountTlsAccepted(make(old))).rejects.toThrow(
      /refuses the fixture authority's certificate for account\.first-run\.opensteer\.example: self-signed certificate/u,
    );
  });
});
