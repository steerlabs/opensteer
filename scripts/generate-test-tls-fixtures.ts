/** Regenerate disposable test identities with OpenSSL; never use for deployment. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "opensteer-test-tls-"));
function openssl(...args: string[]): void {
  execFileSync("openssl", args, { stdio: "inherit" });
}
try {
  const caKey = path.join(temporary, "ca-key.pem");
  const ca = path.join(temporary, "ca.pem");
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "3650",
    "-subj",
    "/CN=Opensteer disposable test CA",
    "-keyout",
    caKey,
    "-out",
    ca,
  );
  const extensions = path.join(temporary, "extensions.cnf");
  writeFileSync(
    extensions,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth,clientAuth",
      "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:*.example.test",
      "",
    ].join("\n"),
  );
  for (const identity of ["profile", "manager"]) {
    const key = path.join(temporary, `${identity}-key.pem`);
    const csr = path.join(temporary, `${identity}.csr`);
    const cert = path.join(temporary, `${identity}.pem`);
    openssl(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=Opensteer disposable ${identity} test`,
      "-keyout",
      key,
      "-out",
      csr,
    );
    openssl(
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "3650",
      "-extfile",
      extensions,
      "-out",
      cert,
    );
    if (identity === "profile") {
      writeFileSync(
        path.join(root, "apps/desktop/scripts/fixtures/profile-restore-tls.ts"),
        "// Disposable test-only TLS identity. Regenerate: pnpm exec tsx scripts/generate-test-tls-fixtures.ts\n" +
          `export const key = ${JSON.stringify(readFileSync(key, "utf8"))};\n` +
          `export const cert = ${JSON.stringify(readFileSync(cert, "utf8"))};\n`,
      );
    } else {
      const target = path.join(root, "packages/workspace-portablefs/src/test-fixtures");
      writeFileSync(path.join(target, "manager-ca.pem"), readFileSync(ca));
      writeFileSync(path.join(target, "manager-client-key.pem"), readFileSync(key));
      writeFileSync(path.join(target, "manager-client.pem"), readFileSync(cert));
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
