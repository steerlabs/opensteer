import { z } from "zod";
import type { BrowserPreferencesStorage } from "@opensteer/client/host";

/** Only explicit identity choices persist here; recent-site history has a separate owner. */
export function createBrowsingChoiceStorage(file: {
  readonly exists: boolean;
  readonly size: number;
  textSync(): string;
  create(options: { intermediates: boolean; overwrite: boolean }): void;
  writeSync(value: string): void;
}): BrowserPreferencesStorage {
  const schema = z.record(z.string().max(255), z.string().max(512));
  const read = (): Record<string, string> => {
    try {
      if (!file.exists || file.size > 64 * 1024) return {};
      return schema.parse(JSON.parse(file.textSync()));
    } catch {
      return {};
    }
  };
  const write = (value: Record<string, string>) => {
    const encoded = JSON.stringify(value);
    if (encoded.length > 64 * 1024) return;
    if (!file.exists) file.create({ intermediates: true, overwrite: false });
    file.writeSync(encoded);
  };
  const supported = (key: string) =>
    key.startsWith("opensteer.browse-with.v1:") && key.length <= 255;
  return {
    keys: () => Object.keys(read()).filter(supported),
    getItem: (key) => (supported(key) ? (read()[key] ?? null) : null),
    setItem: (key, value) => {
      if (supported(key) && value.length <= 512) write({ ...read(), [key]: value });
    },
    removeItem: (key) => {
      if (supported(key)) {
        const data = read();
        delete data[key];
        write(data);
      }
    },
  };
}
