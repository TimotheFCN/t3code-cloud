import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  CreateEnvironmentSpec,
  EnvironmentDescriptor,
  EnvironmentState,
  PortBinding,
} from "@t3fleet/shared/environment";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { AgentConfig } from "../Config.ts";
import { Driver, DriverError, EnvironmentNotFoundError } from "./Driver.ts";

/**
 * Docker labels tying node resources to environment ids. Labels — not agent
 * state, not the controller DB — are the source of truth for what exists on
 * a node: the driver is stateless, so an agent restart re-adopts every
 * environment simply by querying them.
 */
export const Labels = {
  managed: "t3fleet.managed",
  environmentId: "t3fleet.environment-id",
  environmentName: "t3fleet.environment-name",
  volumeName: "t3fleet.volume-name",
} as const;

/** Where the environment volume is mounted inside the container. */
export const HOME_MOUNT_PATH = "/root";

export const containerName = (environmentId: string) => `t3env-${environmentId}`;
export const volumeName = (environmentId: string) => `t3env-${environmentId}-home`;

// --- docker CLI output shapes (only the fields the driver reads) -------------

const PortBindingJson = Schema.Struct({
  HostIp: Schema.optional(Schema.String),
  HostPort: Schema.String,
});

const ContainerInspectJson = Schema.Struct({
  Id: Schema.String,
  State: Schema.Struct({ Status: Schema.String }),
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.NullOr(
      Schema.Record(Schema.String, Schema.NullOr(Schema.Array(PortBindingJson))),
    ),
  }),
});
type ContainerInspectJson = typeof ContainerInspectJson.Type;

const decodeContainerInspects = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ContainerInspectJson)),
);

const decodeRuntimes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const decodeRepoDigests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const toEnvironmentState = (status: string): EnvironmentState => {
  switch (status) {
    case "created":
      return "created";
    case "running":
    case "restarting":
    case "paused":
      return "running";
    default:
      return "stopped";
  }
};

const toPorts = (inspect: ContainerInspectJson): Array<PortBinding> => {
  const ports: Array<PortBinding> = [];
  for (const [key, bindings] of Object.entries(inspect.NetworkSettings.Ports ?? {})) {
    const containerPort = Number.parseInt(key, 10);
    const hostPort = bindings?.[0]?.HostPort;
    if (!Number.isInteger(containerPort)) {
      continue;
    }
    ports.push(
      hostPort === undefined
        ? { containerPort }
        : { containerPort, hostPort: Number.parseInt(hostPort, 10) },
    );
  }
  return ports;
};

const decodeAs =
  <A, E>(operation: string, decode: (input: string) => Effect.Effect<A, E>) =>
  (input: string) =>
    decode(input).pipe(
      Effect.mapError(
        (cause) =>
          new DriverError({
            operation,
            message: `unexpected docker output: ${String(cause)}`,
            cause,
          }),
      ),
    );

const toDescriptor = (inspect: ContainerInspectJson): EnvironmentDescriptor => {
  const labels = inspect.Config.Labels ?? {};
  const ports = toPorts(inspect);
  return {
    id: labels[Labels.environmentId] ?? "",
    name: labels[Labels.environmentName] ?? "",
    image: inspect.Config.Image,
    state: toEnvironmentState(inspect.State.Status),
    containerId: inspect.Id,
    volumeName: labels[Labels.volumeName],
    ...(ports.length > 0 ? { ports } : {}),
  };
};

/**
 * The production driver: shells out to the `docker` CLI (decision recorded in
 * the phase-2 handoff — no dockerode dependency; parseable `--format json`
 * output; the CLI is a node prerequisite anyway).
 *
 * Environment containers run under the configured runtime, `sysbox-runc` by
 * default. When that runtime is missing the driver fails with a diagnostic —
 * it never falls back to `--privileged`, because sysbox is exactly what makes
 * the inner Docker daemon safe.
 */
export const layer = Layer.effect(
  Driver,
  Effect.gen(function* () {
    const config = yield* AgentConfig;
    const spawner = yield* ChildProcessSpawner;
    const snapshotsRoot = NodePath.resolve(config.stateDir, "snapshots");

    /** Runs `docker <args>`, capturing stdout/stderr separately. */
    const runDocker = Effect.fn("DockerDriver.runDocker")(function* (
      operation: string,
      args: ReadonlyArray<string>,
    ) {
      return yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("docker", args));
        const [stdout, stderr] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ],
          { concurrency: 2 },
        );
        const exitCode = yield* handle.exitCode;
        return { exitCode: Number(exitCode), stdout, stderr };
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new DriverError({
              operation,
              message: `failed to run docker ${args[0] ?? ""}: ${String(cause)}`,
              cause,
            }),
        ),
      );
    });

    /** Runs `docker <args>` and fails `DriverError` on a non-zero exit. */
    const docker = Effect.fn("DockerDriver.docker")(function* (
      operation: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* runDocker(operation, args);
      if (result.exitCode !== 0) {
        return yield* new DriverError({
          operation,
          message:
            `docker ${args.join(" ")} exited with code ${result.exitCode}: ` + result.stderr.trim(),
        });
      }
      return result.stdout;
    });

    const inspectContainers = Effect.fn("DockerDriver.inspectContainers")(function* (
      operation: string,
      containerIds: ReadonlyArray<string>,
    ) {
      if (containerIds.length === 0) {
        return [];
      }
      const output = yield* docker(operation, ["container", "inspect", ...containerIds]);
      return yield* decodeAs(operation, decodeContainerInspects)(output);
    });

    const listManagedContainerIds = Effect.fn("DockerDriver.listManagedContainerIds")(function* (
      operation: string,
      environmentId?: string,
    ) {
      const filters = [
        "--filter",
        `label=${Labels.managed}=true`,
        ...(environmentId === undefined
          ? []
          : ["--filter", `label=${Labels.environmentId}=${environmentId}`]),
      ];
      const output = yield* docker(operation, ["ps", "-a", "-q", "--no-trunc", ...filters]);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    });

    const findContainer = Effect.fn("DockerDriver.findContainer")(function* (
      operation: string,
      environmentId: string,
    ) {
      const ids = yield* listManagedContainerIds(operation, environmentId);
      const inspects = yield* inspectContainers(operation, ids);
      return inspects.length === 0 ? Option.none() : Option.some(inspects[0]!);
    });

    const requireContainer = Effect.fn("DockerDriver.requireContainer")(function* (
      operation: string,
      environmentId: string,
    ) {
      const found = yield* findContainer(operation, environmentId);
      if (Option.isNone(found)) {
        return yield* new EnvironmentNotFoundError({ environmentId });
      }
      return found.value;
    });

    const listManagedVolumeNames = Effect.fn("DockerDriver.listManagedVolumeNames")(function* (
      operation: string,
      environmentId: string,
    ) {
      const output = yield* docker(operation, [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${Labels.environmentId}=${environmentId}`,
      ]);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    });

    /**
     * Fails when the configured container runtime is not registered with the
     * Docker daemon. Deliberately loud: without sysbox the inner Docker
     * daemon cannot work in an unprivileged container, and falling back to
     * `--privileged` silently would hand every environment root on the node.
     */
    const ensureRuntimeAvailable = Effect.fn("DockerDriver.ensureRuntimeAvailable")(function* (
      operation: string,
    ) {
      const output = yield* docker(operation, ["info", "--format", "{{json .Runtimes}}"]);
      const runtimes = yield* decodeAs(operation, decodeRuntimes)(output.trim());
      if (!(config.dockerRuntime in runtimes)) {
        return yield* new DriverError({
          operation,
          message:
            `container runtime "${config.dockerRuntime}" is not available on this node ` +
            `(daemon knows: ${Object.keys(runtimes).join(", ")}). Environments need the ` +
            `sysbox runtime for a working inner Docker daemon without --privileged — ` +
            `install sysbox (https://github.com/nestybox/sysbox) and restart dockerd. ` +
            `Fleet never falls back to a privileged container.`,
        });
      }
    });

    const pullImage = Effect.fn("DockerDriver.pullImage")(function* (reference: string) {
      yield* docker("pullImage", ["pull", "--quiet", reference]);
      const output = yield* docker("pullImage", [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        reference,
      ]);
      const digests = yield* decodeAs("pullImage", decodeRepoDigests)(output.trim());
      return { reference, digest: digests[0] ?? null };
    });

    const createEnvironment = Effect.fn("DockerDriver.createEnvironment")(function* (
      spec: CreateEnvironmentSpec,
    ) {
      // Idempotent per environment id: a retried create (e.g. after a
      // controller crash) adopts the existing container instead of failing.
      const existing = yield* findContainer("createEnvironment", spec.id);
      if (Option.isSome(existing)) {
        yield* Effect.logInfo(`createEnvironment: adopting existing container for ${spec.id}`);
        return toDescriptor(existing.value);
      }

      yield* ensureRuntimeAvailable("createEnvironment");

      const volume = volumeName(spec.id);
      yield* docker("createEnvironment", [
        "volume",
        "create",
        "--label",
        `${Labels.managed}=true`,
        "--label",
        `${Labels.environmentId}=${spec.id}`,
        volume,
      ]);

      const envFlags = Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]);
      const portFlags = (spec.publishPorts ?? []).flatMap((port) => [
        "-p",
        port.hostPort === undefined
          ? `${port.containerPort}`
          : `${port.hostPort}:${port.containerPort}`,
      ]);

      const containerId = yield* docker("createEnvironment", [
        "container",
        "create",
        "--name",
        containerName(spec.id),
        "--hostname",
        spec.name,
        "--runtime",
        config.dockerRuntime,
        "--label",
        `${Labels.managed}=true`,
        "--label",
        `${Labels.environmentId}=${spec.id}`,
        "--label",
        `${Labels.environmentName}=${spec.name}`,
        "--label",
        `${Labels.volumeName}=${volume}`,
        "--mount",
        `type=volume,src=${volume},dst=${HOME_MOUNT_PATH}`,
        ...envFlags,
        ...portFlags,
        spec.image,
      ]);

      const inspects = yield* inspectContainers("createEnvironment", [containerId.trim()]);
      return toDescriptor(inspects[0]!);
    });

    const startEnvironment = Effect.fn("DockerDriver.startEnvironment")(function* (
      environmentId: string,
    ) {
      const container = yield* requireContainer("startEnvironment", environmentId);
      yield* docker("startEnvironment", ["start", container.Id]);
      const inspects = yield* inspectContainers("startEnvironment", [container.Id]);
      return toDescriptor(inspects[0]!);
    });

    const stopEnvironment = Effect.fn("DockerDriver.stopEnvironment")(function* (
      environmentId: string,
    ) {
      const container = yield* requireContainer("stopEnvironment", environmentId);
      yield* docker("stopEnvironment", ["stop", container.Id]);
      const inspects = yield* inspectContainers("stopEnvironment", [container.Id]);
      return toDescriptor(inspects[0]!);
    });

    const destroyEnvironment = Effect.fn("DockerDriver.destroyEnvironment")(function* (
      environmentId: string,
    ) {
      const container = yield* findContainer("destroyEnvironment", environmentId);
      const volumes = yield* listManagedVolumeNames("destroyEnvironment", environmentId);
      if (Option.isNone(container) && volumes.length === 0) {
        return yield* new EnvironmentNotFoundError({ environmentId });
      }
      if (Option.isSome(container)) {
        yield* docker("destroyEnvironment", ["rm", "--force", container.value.Id]);
      }
      // Volumes are removed even when the container is already gone, so a
      // destroy interrupted halfway converges on retry.
      for (const volume of volumes) {
        yield* docker("destroyEnvironment", ["volume", "rm", volume]);
      }
    });

    const execInEnvironment = Effect.fn("DockerDriver.execInEnvironment")(function* (
      environmentId: string,
      command: ReadonlyArray<string>,
    ) {
      const container = yield* requireContainer("execInEnvironment", environmentId);
      if (toEnvironmentState(container.State.Status) !== "running") {
        return yield* new DriverError({
          operation: "execInEnvironment",
          message: `environment ${environmentId} is not running (state: ${container.State.Status})`,
        });
      }
      // The command's own non-zero exit is a valid result, not a driver error.
      return yield* runDocker("execInEnvironment", ["exec", container.Id, ...command]);
    });

    const pruneSnapshots = Effect.fn("DockerDriver.pruneSnapshots")(function* (
      snapshotDir: string,
    ) {
      const entries = yield* Effect.tryPromise({
        try: () => NodeFs.readdir(snapshotDir),
        catch: (cause) =>
          new DriverError({
            operation: "snapshotVolume",
            message: `cannot list snapshot directory ${snapshotDir}`,
            cause,
          }),
      });
      // Filenames embed a fixed-width epoch-millis prefix, so a plain
      // descending sort is newest-first.
      const stale = entries
        .filter((entry) => entry.endsWith(".tar.gz"))
        .toSorted()
        .toReversed()
        .slice(Math.max(config.snapshotRetention, 1));
      for (const entry of stale) {
        yield* Effect.promise(() => NodeFs.rm(NodePath.join(snapshotDir, entry), { force: true }));
      }
    });

    const snapshotVolume = Effect.fn("DockerDriver.snapshotVolume")(function* (
      environmentId: string,
    ) {
      const container = yield* requireContainer("snapshotVolume", environmentId);
      const volume = container.Config.Labels?.[Labels.volumeName] ?? volumeName(environmentId);
      const snapshotDir = NodePath.join(snapshotsRoot, environmentId);
      yield* Effect.promise(() => NodeFs.mkdir(snapshotDir, { recursive: true }));

      const now = yield* Clock.currentTimeMillis;
      const fileName = `${String(now).padStart(15, "0")}.tar.gz`;
      const path = NodePath.join(snapshotDir, fileName);

      yield* docker("snapshotVolume", [
        "run",
        "--rm",
        "--mount",
        `type=volume,src=${volume},dst=/volume,readonly`,
        "--mount",
        `type=bind,src=${snapshotDir},dst=/backup`,
        config.helperImage,
        "tar",
        "-czf",
        `/backup/${fileName}`,
        "-C",
        "/volume",
        ".",
      ]);

      const stat = yield* Effect.tryPromise({
        try: () => NodeFs.stat(path),
        catch: (cause) =>
          new DriverError({
            operation: "snapshotVolume",
            message: `snapshot was not written at ${path}`,
            cause,
          }),
      });
      yield* pruneSnapshots(snapshotDir);
      return { path, createdAtMillis: now, sizeBytes: stat.size };
    });

    const restoreVolume = Effect.fn("DockerDriver.restoreVolume")(function* (
      environmentId: string,
      snapshotPath: string,
    ) {
      const container = yield* requireContainer("restoreVolume", environmentId);
      if (toEnvironmentState(container.State.Status) === "running") {
        return yield* new DriverError({
          operation: "restoreVolume",
          message: `environment ${environmentId} must be stopped before restoring a snapshot`,
        });
      }
      const absolute = NodePath.resolve(snapshotPath);
      yield* Effect.tryPromise({
        try: () => NodeFs.access(absolute),
        catch: (cause) =>
          new DriverError({
            operation: "restoreVolume",
            message: `snapshot not found at ${absolute}`,
            cause,
          }),
      });
      const volume = container.Config.Labels?.[Labels.volumeName] ?? volumeName(environmentId);
      yield* docker("restoreVolume", [
        "run",
        "--rm",
        "--mount",
        `type=volume,src=${volume},dst=/volume`,
        "--mount",
        `type=bind,src=${NodePath.dirname(absolute)},dst=/backup,readonly`,
        config.helperImage,
        "sh",
        "-c",
        `find /volume -mindepth 1 -delete && tar -xzf /backup/${NodePath.basename(absolute)} -C /volume`,
      ]);
    });

    const listEnvironments = Effect.gen(function* () {
      const ids = yield* listManagedContainerIds("listEnvironments");
      const inspects = yield* inspectContainers("listEnvironments", ids);
      return inspects.map(toDescriptor);
    });

    return Driver.of({
      pullImage,
      createEnvironment,
      startEnvironment,
      stopEnvironment,
      destroyEnvironment,
      execInEnvironment,
      snapshotVolume,
      restoreVolume,
      listEnvironments,
    });
  }),
);
