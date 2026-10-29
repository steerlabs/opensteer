"""Host-safe signature and audit-token journey; produces JSON evidence.

Usage: python3 scripts/verify-signed-helper.py SIGNING_JSON HELPER_APP EVIDENCE_DIR
No windows, input injection, or permission prompts. Temporary peers are removed.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

signing_file, bundle, evidence = map(Path, sys.argv[1:4])
verifier = Path(sys.argv[4]) if len(sys.argv) == 5 else None
signing = json.loads(signing_file.read_text())
keychain_arguments = []
if "keychain" in signing:
    keychain = signing["keychain"]
    if (not isinstance(keychain, str) or not keychain or
            not Path(keychain).is_absolute() or
            not keychain.endswith(".keychain-db") or not Path(keychain).is_file()):
        raise ValueError("keychain must be an absolute path to an existing .keychain-db file")
    keychain_arguments = ["--keychain", keychain]
team = signing["teamId"]
identity = signing["identity"]
evidence.mkdir(parents=True, exist_ok=True)
markers = 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]'
def requirement(team_id):
    return f'{markers} and certificate leaf[subject.OU] = "{team_id}" and identifier "com.opensteer.computer-use"'

def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=120, **kwargs)

results = {}
for label, expected_team, expected in [("configured-team", team, 0), ("other-team", "ZZZZZ12345" if team != "ZZZZZ12345" else "ABCDE12345", 1)]:
    checked = run(["/usr/bin/codesign", "--verify", "--strict", "-R=" + requirement(expected_team), str(bundle)])
    results[label] = {"exit": checked.returncode, "output": checked.stdout + checked.stderr}
    assert (checked.returncode == 0) == (expected == 0), results[label]

source = r'''
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strlcpy(address.sun_path, argv[1], sizeof(address.sun_path));
  if (connect(fd, (struct sockaddr *)&address, sizeof(address))) return 3;
  char value;
  read(fd, &value, 1);
  close(fd);
  return 0;
}
'''
with tempfile.TemporaryDirectory(prefix="i3b-peer-") as temporary:
    directory = Path(temporary)
    (directory / "peer.c").write_text(source)
    peer = directory / "peer"
    compile_result = run(["/usr/bin/clang", str(directory / "peer.c"), "-o", str(peer)])
    assert compile_result.returncode == 0, compile_result.stderr
    helper_command = [str(bundle / "Contents/MacOS/Opensteer Computer Use"), "--verify-peer"]
    scenarios = [("signed-peer", identity, 0, helper_command), ("unsigned-peer", "-", 1, helper_command)]
    if verifier:
        assert verifier.is_file(), "Build the test-only PeerVerificationFixture first"
        scenarios.extend([
            ("same-team-audit-seam", identity, 0, [str(verifier), team]),
            ("other-team-audit-seam", identity, 1, [str(verifier), "ZZZZZ12345" if team != "ZZZZZ12345" else "ABCDE12345"]),
        ])
    for label, certificate, expected, verification_command in scenarios:
        signed = run(["/usr/bin/codesign", "--force", *(keychain_arguments if certificate != "-" else []), "--sign", certificate, "--identifier", "com.opensteer.computer-use", *(["--options", "runtime", "--timestamp"] if certificate != "-" else []), str(peer)])
        assert signed.returncode == 0, signed.stderr
        address = str(directory / "ipc.sock")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(address)
            server.listen(1)
            server.settimeout(10)
            client = subprocess.Popen([str(peer), address])
            try:
                connection, _ = server.accept()
                with connection:
                    descriptor = connection.fileno()
                    # The helper consumes descriptor 3. Duplicate in the child only.
                    def inherit():
                        os.dup2(descriptor, 3)
                    result = run(verification_command, pass_fds=(descriptor, 3), preexec_fn=inherit)
                    results[label] = {"exit": result.returncode, "output": result.stdout + result.stderr}
                    assert (result.returncode == 0) == (expected == 0), results[label]
            finally:
                client.terminate()
                client.wait(timeout=10)
                os.unlink(address)
(evidence / "peer-verification.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
