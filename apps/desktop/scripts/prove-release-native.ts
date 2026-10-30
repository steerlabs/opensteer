import path from "node:path";
import { buildSwiftProducts } from "./build-swift-products.js";
import { verifyNativeProducts } from "./native-build-cache.js";
import { buildPasskeysAddon } from "./build-passkeys-addon.js";
import { generateAppleDataContracts } from "../../../scripts/generate-apple-data-contracts.js";

const root = path.resolve(import.meta.dirname, "../../..");
await generateAppleDataContracts();
for (const [directory, products] of [
  ["computer-use", ["ComputerUseHelper"]],
  ["passwords", ["PasswordsBroker", "PasswordsImportWorker"]],
  ["dictation", ["DictationHelper"]],
] as const) {
  const bin = buildSwiftProducts(path.join(root, "apps/desktop/native", directory), products, [
    "arm64",
    "x86_64",
  ]);
  await verifyNativeProducts(
    Object.fromEntries(products.map((product) => [product, path.join(bin, product)])),
    ["arm64", "x86_64"],
  );
}
if (!process.argv.includes("--swift-only")) await buildPasskeysAddon();
