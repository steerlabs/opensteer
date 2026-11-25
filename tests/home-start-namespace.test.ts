// A Home's gateway, Runner and Channel Runtime join the Host's network namespace
// (`network_mode: service:host`). Docker binds each of them to the Host container that ran when
// it was created; a Host created anew afterwards leaves them where nothing listens. A start must
// leave the Home reachable when it returns, and touch nothing when nothing changed (deploy/home
// start_pod).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const source = join(import.meta.dirname, "../deploy/home");
let work: string;
let home: string;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "opensteer-home-namespace-")));
  home = join(work, "home");
  mkdirSync(join(home, "secrets"), { recursive: true });
  mkdirSync(join(work, "pod"));
  writeFileSync(join(home, "config.env"), "COMPOSE_PROJECT_NAME='namespace-test'\n");
  // A Cloud Computer: its services' limits come from the machine it is on.
  writeFileSync(join(home, "browser-pool"), "");
  writeFileSync(join(work, "size"), "3908 2\n");
  writeFileSync(join(work, "next"), "0\n");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/**
 * Docker and Docker Compose stood in for. Each container is work/pod/<service>: "ID CONFIG MODE".
 * A service is created when it has no container, when what it is asked for differs (unless
 * --no-recreate), or under --force-recreate; one that joins the Host is bound to the Host
 * container that exists when it is created, by id, as Docker binds `container:<id>`. Each
 * creation and each firewall is logged to work/events, in order.
 */
const standIn = () => `
pod=${JSON.stringify(join(work, "pod"))} events=${JSON.stringify(join(work, "events"))}
joiners=(gateway runner channel-runtime)
machine_size() { cat ${JSON.stringify(join(work, "size"))}; }
prepare_runner_apparmor() { :; }
apply_firewall() { printf 'firewall on %s\\n' "$(field host 1)" >> "$events"; }
check_firewall() { :; }
readlink() { if [[ $1 == /proc/* ]]; then echo "net:[$1]"; else command readlink "$@"; fi; }
field() { [[ -f $pod/$1 ]] && cut -d' ' -f"$2" "$pod/$1"; }
create() {
  local id mode=default
  id=c$(( $(cat ${JSON.stringify(join(work, "next"))}) + 1 ))
  echo "\${id#c}" > ${JSON.stringify(join(work, "next"))}
  if [[ " \${joiners[*]} " == *" $1 "* ]]; then mode=container:$(field host 1); fi
  printf '%s %s %s\\n' "$id" "$2" "$mode" > "$pod/$1"
  if [[ $mode == default ]]; then printf 'creates %s\\n' "$1"; else printf 'creates %s on %s\\n' "$1" "\${mode#container:}"; fi >> "$events"
}
up() {
  local force=false keep=false services=() service config
  while (($#)); do
    case $1 in
      --wait-timeout | --pull) shift 2 ;;
      --force-recreate) force=true; shift ;;
      --no-recreate) keep=true; shift ;;
      -*) shift ;;
      *) services+=("$1"); shift ;;
    esac
  done
  ((\${#services[@]})) || services=(postgres host "\${joiners[@]}")
  for service in "\${services[@]}"; do
    config=\${limit[$service]:-none}
    if [[ ! -f $pod/$service ]] || $force || { ! $keep && [[ $(field "$service" 2) != "$config" ]]; }; then
      create "$service" "$config"
    fi
  done
}
env() {
  declare -A limit=()
  while [[ $1 != docker ]]; do
    case $1 in
      OPENSTEER_HOME_LIMIT_POSTGRES_MEMORY=*) limit[postgres]=\${1#*=} ;;
      OPENSTEER_HOME_LIMIT_HOST_MEMORY=*) limit[host]=\${1#*=} ;;
      OPENSTEER_HOME_LIMIT_GATEWAY_MEMORY=*) limit[gateway]=\${1#*=} ;;
      OPENSTEER_HOME_LIMIT_RUNNER_MEMORY=*) limit[runner]=\${1#*=} ;;
      OPENSTEER_HOME_LIMIT_CHANNEL_MEMORY=*) limit[channel-runtime]=\${1#*=} ;;
    esac
    shift
  done
  shift 2
  while [[ $1 == -* ]]; do shift 2; done
  case $1 in
    up) shift; up "$@" ;;
    ps) field host 1 ;;
    down) rm -f -- "$pod"/* ;;
  esac
}
docker() {
  local id file
  case "$1 $*" in
    "ps "*service=host*) field host 1 ;;
    "ps "*) cat "$pod"/* 2>/dev/null | cut -d' ' -f1 ;;
    "inspect "*State.Pid*) id=\${*: -1}; echo "1\${id#c}" ;;
    "inspect "*NetworkMode*)
      for id in "\${@:4}"; do
        for file in "$pod"/*; do
          [[ $(cut -d' ' -f1 "$file") == "$id" ]] && printf '%s %s\\n' "\${file##*/}" "$(cut -d' ' -f3 "$file")"
        done
      done ;;
    *) return 1 ;;
  esac
}
# Reachable: every service that joins the Host joins the Host that runs.
reachable() {
  local service
  for service in "\${joiners[@]}"; do
    [[ $(field "$service" 3) == "container:$(field host 1)" ]] || { echo unreachable; return; }
  done
  echo reachable
}
`;

/** Runs SCRIPT with this checkout's code and the stand-ins above. */
function run(script: string) {
  rmSync(join(work, "events"), { force: true });
  return spawnSync(
    "bash",
    ["-c", `source "$1/common.sh"\n${standIn()}\n${script}`, "run", source],
    {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: home },
    },
  );
}

/** `opensteer-home start`'s own step: start_pod, then whether the Home is reachable. */
const start = () => run("start_pod && reachable");
const events = () => readFileSync(join(work, "events"), "utf8").trim().split("\n");
const host = () => readFileSync(join(work, "pod", "host"), "utf8").split(" ")[0];

it("starts a Home from nothing: each service joins the Host that runs, after the Host's firewall", () => {
  const started = start();
  expect(started.stdout, started.stderr).toBe("reachable\n");
  const h = host();
  expect(events()).toEqual([
    "creates postgres",
    "creates host",
    `firewall on ${h}`,
    `creates gateway on ${h}`,
    `creates runner on ${h}`,
    `creates channel-runtime on ${h}`,
  ]);
});

it("starts a running Home with nothing changed: no container is created anew", () => {
  expect(start().stdout).toBe("reachable\n");
  const again = start();
  expect(again.stdout, again.stderr).toBe("reachable\n");
  expect(events().filter((event) => event.startsWith("creates"))).toEqual([]);
});

it("starts a running Home whose Host's limits changed: the services that joined the old Host join the new one in the same start", () => {
  expect(start().stdout).toBe("reachable\n");
  const before = host();
  // The machine grew: the Host's limit changes, so Compose creates the Host anew.
  writeFileSync(join(work, "size"), "15624 4\n");
  const started = start();
  // Reachable when the start returns, not a maintenance pass later.
  expect(started.stdout, started.stderr).toBe("reachable\n");
  const h = host();
  expect(h).not.toBe(before);
  const steps = events();
  expect(steps.filter((event) => event === "creates host")).toHaveLength(1);
  // Each service that joined the old Host joins the new one, after the new Host's firewall.
  const firewall = steps.indexOf(`firewall on ${h}`);
  expect(firewall).toBeGreaterThan(steps.indexOf("creates host"));
  for (const service of ["gateway", "runner", "channel-runtime"]) {
    expect(steps.filter((event) => event.startsWith(`creates ${service} `))).toEqual([
      `creates ${service} on ${h}`,
    ]);
    expect(steps.indexOf(`creates ${service} on ${h}`)).toBeGreaterThan(firewall);
  }
});

it("starts a Home a start left stranded before: the services bound to a Host that is gone join the one that runs", () => {
  expect(start().stdout).toBe("reachable\n");
  // As an earlier start (or an older release's) left it: the Host created anew, the others not.
  const created = run(`create host "$(field host 2)"; reachable`);
  expect(created.stdout).toBe("unreachable\n");
  const started = start();
  expect(started.stdout, started.stderr).toBe("reachable\n");
  // The Host that runs stays; only the stranded services are created anew.
  expect(
    events()
      .filter((event) => event.startsWith("creates"))
      .sort(),
  ).toEqual([
    `creates channel-runtime on ${host()}`,
    `creates gateway on ${host()}`,
    `creates runner on ${host()}`,
  ]);
});
