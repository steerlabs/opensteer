import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "./command-runner.js";

const directory = await mkdtemp(
  path.join(process.env.OPENSTEER_PHASE_F_EVIDENCE_DIRECTORY ?? tmpdir(), "opensteer-tree-review-"),
);
const fixture = path.join(directory, "journey.py");
await writeFile(
  fixture,
  `import builtins, importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('tree', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = sys.argv[2]
root = pathlib.Path(sys.argv[3]) / case / 'Prepared.next'
root.mkdir(parents=True)
(root / 'payload').write_bytes(b'original')
outside = root.parent / 'outside'
outside.write_bytes(b'external')
if case == 'directory-race':
    original_open = builtins.open
    def racing_open(filename, *args, **kwargs):
        if os.fspath(filename) == str(root / 'payload'):
            with original_open(root / 'late-extra', 'w') as extra:
                extra.write('injected after listdir')
        return original_open(filename, *args, **kwargs)
    builtins.open = racing_open
elif case == 'escaping-symlink':
    os.symlink('../outside', root / 'escape')
elif case == 'external-hardlink':
    os.link(outside, root / 'hardlink')
elif case == 'internal-hardlink':
    os.link(root / 'payload', root / 'hardlink')
elif case == 'internal-symlink':
    os.symlink('payload', root / 'current')
elif case == 'escaping-chain':
    os.symlink('../outside', root / 'escape')
    os.symlink('escape', root / 'current')
try:
    module.inventory(str(root))
except (ValueError, OSError) as error:
    if case == 'internal-symlink': raise
    print(json.dumps({'case':case,'passed':True,'rejection':str(error)}))
else:
    if case != 'internal-symlink': raise AssertionError('Untrusted prepared tree accepted: ' + case)
    print(json.dumps({'case':case,'passed':True}))
`,
);
const results: unknown[] = [];
for (const scenario of process.argv[2]
  ? [process.argv[2]]
  : [
      "directory-race",
      "escaping-symlink",
      "escaping-chain",
      "external-hardlink",
      "internal-hardlink",
      "internal-symlink",
    ]) {
  const output = await runBounded(
    "python3",
    [fixture, fileURLToPath(new URL("./mac-app-tree.py", import.meta.url)), scenario, directory],
    { env: { PYTHONDONTWRITEBYTECODE: "1" } },
  );
  const result: unknown = JSON.parse(output);
  assert.ok(result);
  results.push(result);
}
await writeFile(path.join(directory, "report.json"), JSON.stringify({ results }, null, 2));
process.stdout.write(`${directory}\n`);
