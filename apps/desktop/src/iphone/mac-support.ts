import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const developerImages = "/Library/Developer/DeveloperDiskImages";
export interface IphoneMacSupport {
  inspect(): Promise<{ xcodeApps: string[]; imageRoots: string[]; xcodeInstalling: boolean }>;
  watch(changed: () => void): () => void;
  help(action: "get-xcode" | "open-xcode" | "open-local-network", xcodeApp?: string): Promise<void>;
}
async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
export const iphoneMacSupport: IphoneMacSupport = {
  async inspect() {
    const [selected, indexed, applications] = await Promise.all([
      execute("/usr/bin/xcode-select", ["-p"], { timeout: 5000 }).then(
        (r) => r.stdout,
        () => "",
      ),
      execute("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"], {
        timeout: 5000,
      }).then(
        (r) => r.stdout,
        () => "",
      ),
      readdir("/Applications").catch(() => []),
    ]);
    const selectedApp = selected.trim().match(/^(.*\.app)\/Contents\/Developer\/?$/)?.[1];
    const possible = [
      ...new Set([
        ...(selectedApp ? [selectedApp] : []),
        ...indexed.trim().split("\n").filter(Boolean),
        ...applications
          .filter((name) => /^Xcode.*\.app$/.test(name))
          .map((name) => path.join("/Applications", name)),
      ]),
    ];
    const present = (
      await Promise.all(possible.map(async (app) => ((await exists(app)) ? app : null)))
    ).filter((app): app is string => app !== null);
    const complete = await Promise.all(
      present.map((app) => exists(path.join(app, "Contents/Developer"))),
    );
    const xcodeApps = present.filter((_, index) => complete[index]);
    const bundled = await Promise.all(
      xcodeApps.map(async (app) => {
        const root = path.join(app, "Contents/Resources/CoreDeviceDDIs/iOS_DDI/Restore");
        return (await exists(root)) ? root : null;
      }),
    );
    return {
      xcodeApps,
      xcodeInstalling: present.length > xcodeApps.length,
      imageRoots: [
        path.join(developerImages, "iOS_DDI/Restore"),
        ...bundled.filter((root): root is string => root !== null),
      ].slice(0, 8),
    };
  },
  watch(changed) {
    const watchers = [developerImages, "/Library/Developer", "/Applications"].flatMap((root) => {
      try {
        const watcher = watch(root, { recursive: root === developerImages }, changed);
        watcher.on("error", () => watcher.close());
        return [watcher];
      } catch {
        return [];
      }
    });
    // Installation can replace a watched directory, or create one that didn't exist yet.
    const fallback = setInterval(changed, 5000);
    return () => {
      clearInterval(fallback);
      for (const watcher of watchers) watcher.close();
    };
  },
  async help(action, xcodeApp) {
    if (action === "get-xcode")
      await execute("/usr/bin/open", ["macappstore://apps.apple.com/app/id497799835"]);
    // Apple’s Settings extension names this anchor differently from its Privacy_* anchors.
    else if (action === "open-local-network")
      await execute("/usr/bin/open", [
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?privacy-localnetwork",
      ]);
    else if (xcodeApp) await execute("/usr/bin/open", ["-a", xcodeApp]);
  },
};
