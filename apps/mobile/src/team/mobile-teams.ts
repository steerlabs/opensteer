import type { TeamRuntimeOwner } from "@opensteer/client/team";
import { MobileTeamRuntime } from "./mobile-team-runtime.js";
export * from "./mobile-team-runtime.js";

type Options = ConstructorParameters<typeof MobileTeamRuntime>[0];

/** One service facade; each Account owns an isolated runtime and its entire mutable state. */
export class MobileTeams {
  readonly #options: Options;
  readonly #listeners = new Set<() => void>();
  #runtime: MobileTeamRuntime;
  #detachRuntime: (() => void) | null = null;
  #detachIdentity: (() => void) | null = null;
  #foreground = true;
  constructor(options: Options) {
    this.#options = options;
    this.#runtime = new MobileTeamRuntime(options);
  }
  get owner(): TeamRuntimeOwner {
    return this.#runtime.owner;
  }
  get registry() {
    return this.#runtime.registry;
  }
  readonly getSnapshot = () => this.#runtime.getSnapshot();
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish = () => {
    for (const listener of this.#listeners) listener();
  };
  start(): void {
    if (this.#detachIdentity) return;
    this.#detachIdentity = this.#options.client.oauth.subscribeAccountIdentityChanges(() =>
      this.#establish(),
    );
    if (!this.#establish()) {
      this.#detachRuntime = this.#runtime.subscribe(this.#publish);
      this.#runtime.start();
    }
  }
  #establish(): boolean {
    if (this.owner === this.#options.client.oauth.teamRuntime()) return false;
    this.#detachRuntime?.();
    this.#runtime.dispose();
    this.#runtime = new MobileTeamRuntime(this.#options);
    this.#detachRuntime = this.#runtime.subscribe(this.#publish);
    this.#runtime.foreground(this.#foreground);
    this.#runtime.start();
    this.#publish();
    return true;
  }
  dispose(): void {
    this.#detachIdentity?.();
    this.#detachIdentity = null;
    this.#detachRuntime?.();
    this.#runtime.dispose();
  }
  foreground(active: boolean): void {
    this.#foreground = active;
    this.#runtime.foreground(active);
  }
  #run<Value>(work: (runtime: MobileTeamRuntime) => Promise<Value>): Promise<Value> {
    const runtime = this.#runtime;
    return runtime.owner.run(() => work(runtime));
  }
  readonly team = (...args: Parameters<MobileTeamRuntime["team"]>) => this.#runtime.team(...args);
  readonly teamAt = (...args: Parameters<MobileTeamRuntime["teamAt"]>) =>
    this.#runtime.teamAt(...args);
  readonly teamsOn = (...args: Parameters<MobileTeamRuntime["teamsOn"]>) =>
    this.#runtime.teamsOn(...args);
  readonly computersIn = (...args: Parameters<MobileTeamRuntime["computersIn"]>) =>
    this.#runtime.computersIn(...args);
  readonly forgetMembers = (...args: Parameters<MobileTeamRuntime["forgetMembers"]>) =>
    this.#runtime.forgetMembers(...args);
  readonly addToPhone = (...args: Parameters<MobileTeamRuntime["addToPhone"]>) =>
    this.#run((runtime) => runtime.addToPhone(...args));
  readonly session = (...args: Parameters<MobileTeamRuntime["session"]>) =>
    this.#run((runtime) => runtime.session(...args));
  readonly select = (...args: Parameters<MobileTeamRuntime["select"]>) =>
    this.#runtime.select(...args);
  readonly refresh = (...args: Parameters<MobileTeamRuntime["refresh"]>) =>
    this.#run((runtime) => runtime.refresh(...args));
  readonly members = (...args: Parameters<MobileTeamRuntime["members"]>) =>
    this.#run((runtime) => runtime.members(...args));
  readonly destination = (...args: Parameters<MobileTeamRuntime["destination"]>) =>
    this.#run((runtime) => runtime.destination(...args));
  readonly locate = (...args: Parameters<MobileTeamRuntime["locate"]>) =>
    this.#run((runtime) => runtime.locate(...args));
  readonly verifyTeam = (...args: Parameters<MobileTeamRuntime["verifyTeam"]>) =>
    this.#run((runtime) => runtime.verifyTeam(...args));
  readonly signIn = (...args: Parameters<MobileTeamRuntime["signIn"]>) =>
    this.#run((runtime) => runtime.signIn(...args));
  readonly enter = (...args: Parameters<MobileTeamRuntime["enter"]>) =>
    this.#run((runtime) => runtime.enter(...args));
  readonly restore = (...args: Parameters<MobileTeamRuntime["restore"]>) =>
    this.#run((runtime) => runtime.restore(...args));
  readonly adopt = (...args: Parameters<MobileTeamRuntime["adopt"]>) =>
    this.#run((runtime) => runtime.adopt(...args));
  readonly redeem = (...args: Parameters<MobileTeamRuntime["redeem"]>) =>
    this.#run((runtime) => runtime.redeem(...args));
  readonly leave = (...args: Parameters<MobileTeamRuntime["leave"]>) =>
    this.#run((runtime) => runtime.leave(...args));
  readonly forget = (...args: Parameters<MobileTeamRuntime["forget"]>) =>
    this.#run((runtime) => runtime.forget(...args));
}
