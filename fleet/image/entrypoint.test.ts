import { execFile } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Entrypoint tailnet-join logic, exercised against the real script with
 * PATH-stubbed `tailscaled` / `tailscale` / `t3` binaries. The stubs record
 * every invocation, so the tests assert the exact contract:
 *
 * - first join passes the auth key (and fails loudly without one),
 * - a volume with an existing logged-in identity rejoins WITHOUT any key —
 *   the device identity on the volume is what keeps the URL stable,
 * - the TUN device decides kernel vs userspace networking,
 * - the auth key never reaches the T3 server process.
 */

const entrypointPath = fileURLToPath(new URL("./entrypoint.sh", import.meta.url));

interface Harness {
  readonly dir: string;
  readonly stateDir: string;
  readonly run: (env?: Record<string, string>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  readonly argsOf: (stub: "tailscaled" | "tailscale-up" | "t3") => Promise<Array<string>>;
  readonly fileExists: (relative: string) => Promise<boolean>;
  readonly readFile: (relative: string) => Promise<string | null>;
}

/**
 * The stubs keep state under the harness dir: `<stub>.args` logs one line
 * per invocation; `state/stub-logged-in` marks a completed login the way a
 * real tailscaled state file would. `tailscale status --json` reports
 * NeedsLogin until `up --authkey` succeeds, mirroring the real CLI.
 */
const makeHarness = async (): Promise<Harness> => {
  const dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3env-entrypoint-"));
  const binDir = NodePath.join(dir, "bin");
  const stateDir = NodePath.join(dir, "state");
  const logDir = NodePath.join(dir, "log");
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.mkdir(logDir, { recursive: true });

  const write = async (name: string, contents: string) => {
    await NodeFs.writeFile(NodePath.join(binDir, name), contents, { mode: 0o755 });
  };

  await write(
    "tailscaled",
    `#!/usr/bin/env bash
echo "$@" >> "${dir}/tailscaled.args"
sock=""
for arg in "$@"; do
  case "$arg" in
    --socket=*) sock="\${arg#--socket=}" ;;
  esac
done
# A real unix socket, so the entrypoint's readiness wait sees it.
exec node -e "
  const net = require('net');
  const server = net.createServer();
  server.listen(process.argv[1]);
  setInterval(() => {}, 1000);
" "\${sock}"
`,
  );

  await write(
    "tailscale",
    `#!/usr/bin/env bash
marker="${stateDir}/stub-logged-in"
args=("$@")
# Drop the global --socket flag before dispatching on the subcommand.
sub=""
for arg in "\${args[@]}"; do
  case "$arg" in
    --socket=*) ;;
    *) if [ -z "\${sub}" ]; then sub="$arg"; fi ;;
  esac
done
if [ "\${sub}" = "status" ]; then
  if [ -f "\${marker}" ]; then
    echo '{"BackendState": "Running"}'
  else
    echo '{"BackendState": "NeedsLogin"}'
  fi
  exit 0
fi
if [ "\${sub}" = "up" ]; then
  echo "$@" >> "${dir}/tailscale-up.args"
  if [ "\${TS_STUB_FAIL_UP:-0}" = "1" ]; then
    echo "stub: up failed" >&2
    exit 1
  fi
  for arg in "\${args[@]}"; do
    case "$arg" in
      --authkey=*) mkdir -p "${stateDir}" && touch "\${marker}" ;;
    esac
  done
  exit 0
fi
exit 0
`,
  );

  await write(
    "t3",
    `#!/usr/bin/env bash
echo "$@" >> "${dir}/t3.args"
echo "TS_AUTHKEY=\${TS_AUTHKEY:-<unset>}" > "${dir}/t3.env"
exit 0
`,
  );

  const run = (env: Record<string, string> = {}) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "bash",
        [entrypointPath],
        {
          env: {
            PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
            HOME: dir,
            T3ENV_SKIP_DOCKERD: "1",
            T3ENV_TS_HOSTNAME: "env-test1234",
            T3ENV_TS_STATE_DIR: stateDir,
            T3ENV_TS_SOCKET: NodePath.join(dir, "tailscaled.sock"),
            T3ENV_TUN_DEVICE: NodePath.join(dir, "no-such-tun"),
            T3ENV_LOG_DIR: logDir,
            ...env,
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ exitCode, stdout, stderr });
        },
      );
    });

  const argsOf = async (stub: "tailscaled" | "tailscale-up" | "t3") => {
    try {
      const contents = await NodeFs.readFile(NodePath.join(dir, `${stub}.args`), "utf8");
      return contents.split("\n").filter((line) => line.length > 0);
    } catch {
      return [];
    }
  };

  return {
    dir,
    stateDir,
    run,
    argsOf,
    fileExists: (relative) =>
      NodeFs.access(NodePath.join(dir, relative)).then(
        () => true,
        () => false,
      ),
    readFile: (relative) =>
      NodeFs.readFile(NodePath.join(dir, relative), "utf8").then(
        (contents) => contents,
        () => null,
      ),
  };
};

describe("entrypoint tailnet join", () => {
  it("first join uses the auth key and hostname; the key never reaches t3", async () => {
    const harness = await makeHarness();
    const result = await harness.run({ TS_AUTHKEY: "tskey-auth-first-join" });
    expect(result.exitCode).toBe(0);

    // tailscaled got the volume state dir; no TUN device -> userspace mode.
    const tailscaledArgs = await harness.argsOf("tailscaled");
    expect(tailscaledArgs).toHaveLength(1);
    expect(tailscaledArgs[0]).toContain(`--statedir=${harness.stateDir}`);
    expect(tailscaledArgs[0]).toContain("--tun=userspace-networking");

    const upArgs = await harness.argsOf("tailscale-up");
    expect(upArgs).toHaveLength(1);
    expect(upArgs[0]).toContain("--authkey=tskey-auth-first-join");
    expect(upArgs[0]).toContain("--hostname=env-test1234");

    // The key was unset before `t3 serve` started.
    expect(await harness.readFile("t3.env")).toBe("TS_AUTHKEY=<unset>\n");
    expect(await harness.argsOf("t3")).toEqual(["serve"]);
  });

  it("kernel TUN mode is used when the TUN device exists", async () => {
    const harness = await makeHarness();
    const tunPath = NodePath.join(harness.dir, "fake-tun");
    await NodeFs.writeFile(tunPath, "");
    const result = await harness.run({
      TS_AUTHKEY: "tskey-auth-tun",
      T3ENV_TUN_DEVICE: tunPath,
    });
    expect(result.exitCode).toBe(0);
    const tailscaledArgs = await harness.argsOf("tailscaled");
    expect(tailscaledArgs[0]).not.toContain("--tun=userspace-networking");
  });

  it("a rejoin with existing state never passes an auth key", async () => {
    const harness = await makeHarness();
    // Boot 1: first join consumes the key and persists the identity.
    expect((await harness.run({ TS_AUTHKEY: "tskey-auth-once" })).exitCode).toBe(0);
    // Boot 2: same volume, the (long-expired) key still in the container env.
    expect((await harness.run({ TS_AUTHKEY: "tskey-auth-once" })).exitCode).toBe(0);
    // Boot 3: recreated container without any key at all.
    expect((await harness.run()).exitCode).toBe(0);

    const upArgs = await harness.argsOf("tailscale-up");
    expect(upArgs).toHaveLength(3);
    expect(upArgs[0]).toContain("--authkey=tskey-auth-once");
    expect(upArgs[1]).not.toContain("--authkey");
    expect(upArgs[1]).toContain("--hostname=env-test1234");
    expect(upArgs[2]).not.toContain("--authkey");
  });

  it("aborts loudly when the first join has no auth key", async () => {
    const harness = await makeHarness();
    const result = await harness.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("first tailnet join requires TS_AUTHKEY");
    expect(await harness.argsOf("t3")).toEqual([]);
  });

  it("aborts loudly when the join itself fails", async () => {
    const harness = await makeHarness();
    const result = await harness.run({
      TS_AUTHKEY: "tskey-auth-bad",
      TS_STUB_FAIL_UP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("tailnet join failed");
    expect(await harness.argsOf("t3")).toEqual([]);
  });

  it("skips the tailnet entirely when T3ENV_SKIP_TAILSCALE=1 or no hostname is set", async () => {
    const skipped = await makeHarness();
    expect((await skipped.run({ T3ENV_SKIP_TAILSCALE: "1" })).exitCode).toBe(0);
    expect(await skipped.argsOf("tailscaled")).toEqual([]);
    expect(await skipped.argsOf("t3")).toEqual(["serve"]);

    const noHostname = await makeHarness();
    expect((await noHostname.run({ T3ENV_TS_HOSTNAME: "" })).exitCode).toBe(0);
    expect(await noHostname.argsOf("tailscaled")).toEqual([]);
  });
});
