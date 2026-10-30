import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { DeploymentCatalogStore } from "@opensteer/client/connections";
import type { LocalRunnerService } from "../supervisor/local-runner-service.js";

export class DesktopTrayService {
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
  readonly #iconPath: string;
  readonly #onError: (error: unknown) => void;
  readonly #open: () => void;
  readonly #quit: () => void;
  readonly #runner: Pick<LocalRunnerService, "enrolledRunners" | "subscribe">;
  #refreshTail: Promise<void> = Promise.resolve();
  #tray: Tray | null = null;
  #restartToUpdate: (() => void) | null = null;
  #unsubscribeCatalog: (() => void) | null = null;
  #unsubscribeRunner: (() => void) | null = null;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
    readonly iconPath: string;
    readonly onError: (error: unknown) => void;
    readonly open: () => void;
    readonly quit: () => void;
    readonly runner: Pick<LocalRunnerService, "enrolledRunners" | "subscribe">;
  }) {
    this.#catalog = options.catalog;
    this.#iconPath = options.iconPath;
    this.#onError = options.onError;
    this.#open = options.open;
    this.#quit = options.quit;
    this.#runner = options.runner;
  }

  async start(): Promise<void> {
    if (this.#tray) return;
    // The 18px base asset sets the logical size; Electron loads @2x for Retina displays.
    const icon = nativeImage.createFromPath(this.#iconPath);
    if (icon.isEmpty()) throw new Error("The Opensteer tray icon is unavailable.");
    if (process.platform === "darwin") icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip("Opensteer");
    tray.on("click", this.#open);
    this.#tray = tray;
    this.#unsubscribeCatalog = this.#catalog.subscribe(() => this.#scheduleRefresh());
    this.#unsubscribeRunner = this.#runner.subscribe(() => this.#scheduleRefresh());
    await this.#refresh();
  }

  setRestartToUpdate(restart: (() => void) | undefined): void {
    this.#restartToUpdate = restart ?? null;
    this.#scheduleRefresh();
  }

  dispose(): void {
    this.#unsubscribeCatalog?.();
    this.#unsubscribeCatalog = null;
    this.#unsubscribeRunner?.();
    this.#unsubscribeRunner = null;
    this.#tray?.destroy();
    this.#tray = null;
  }

  #scheduleRefresh(): void {
    this.#refreshTail = this.#refreshTail
      .then(() => this.#refresh())
      .catch((error: unknown) => this.#onError(error));
  }

  async #refresh(): Promise<void> {
    const tray = this.#tray;
    if (!tray) return;
    const [catalog, runners] = await Promise.all([
      this.#catalog.load(),
      this.#runner.enrolledRunners(),
    ]);
    const names = new Map(
      catalog.deployments.map(
        (deployment) => [deployment.authority.document.deploymentId, deployment.name] as const,
      ),
    );
    const statuses = runners
      .flatMap<MenuItemConstructorOptions>((runner) => {
        const name = names.get(runner.deploymentId);
        return name
          ? [
              {
                enabled: false,
                label: `${name} — ${runner.state === "running" ? "running" : "stopped"}`,
              },
            ]
          : [];
      })
      .sort((left, right) => (left.label ?? "").localeCompare(right.label ?? ""));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { click: this.#open, label: "Open Opensteer" },
        ...(statuses.length > 0
          ? ([{ type: "separator" }, ...statuses] satisfies MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        ...(this.#restartToUpdate
          ? [{ click: this.#restartToUpdate, label: "Restart to Update" }]
          : []),
        { click: this.#quit, label: "Quit Opensteer" },
      ]),
    );
  }
}
