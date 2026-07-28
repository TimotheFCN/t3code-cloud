import { createServer, type Server } from "node:http";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { ControllerConfig, defaults as configDefaults } from "../Config.ts";
import * as Database from "../db/Database.ts";
import { Vault } from "../vault/Vault.ts";
import { Tailnet } from "./Tailnet.ts";
import { DEFAULT_ENVIRONMENT_TAG, TailnetSettings } from "./TailnetSettings.ts";

const CLIENT_ID = "kTESTCLIENT";
const CLIENT_SECRET = "tskey-client-kTESTCLIENT-supersecretvalue";
const ACCESS_TOKEN = "tskey-api-test-access-token";
const MINTED_KEY = "tskey-auth-minted-secret-value";

interface FakeApi {
  readonly url: string;
  readonly tokenRequests: Array<URLSearchParams>;
  readonly keyRequests: Array<{ readonly auth: string | undefined; readonly body: unknown }>;
  readonly deletedDeviceIds: Array<string>;
  readonly deletedKeyIds: Array<string>;
  readonly devices: Array<{ id: string; nodeId?: string; hostname: string; name: string }>;
}

const startFakeApi = Effect.gen(function* () {
  const tokenRequests: Array<URLSearchParams> = [];
  const keyRequests: Array<{ auth: string | undefined; body: unknown }> = [];
  const deletedDeviceIds: Array<string> = [];
  const deletedKeyIds: Array<string> = [];
  const devices: FakeApi["devices"] = [];
  let keyCounter = 0;

  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let bodyText = "";
    req.on("data", (chunk: Buffer) => {
      bodyText += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v2/oauth/token") {
        const params = new URLSearchParams(bodyText);
        tokenRequests.push(params);
        if (
          params.get("client_id") !== CLIENT_ID ||
          params.get("client_secret") !== CLIENT_SECRET
        ) {
          return json(401, { message: "invalid client credentials" });
        }
        return json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
      }
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return json(401, { message: "unauthorized" });
      }
      if (req.method === "POST" && req.url === "/api/v2/tailnet/-/keys") {
        keyCounter += 1;
        keyRequests.push({
          auth: req.headers.authorization,
          body: JSON.parse(bodyText) as unknown,
        });
        return json(200, { id: `key-${keyCounter}`, key: MINTED_KEY });
      }
      if (req.method === "GET" && req.url === "/api/v2/tailnet/-/devices") {
        return json(200, { devices });
      }
      const deviceMatch = req.url?.match(/^\/api\/v2\/device\/([^/]+)$/);
      if (req.method === "DELETE" && deviceMatch !== null && deviceMatch !== undefined) {
        const deviceId = decodeURIComponent(deviceMatch[1]!);
        const index = devices.findIndex(
          (device) => device.nodeId === deviceId || device.id === deviceId,
        );
        if (index === -1) {
          return json(404, { message: "device not found" });
        }
        devices.splice(index, 1);
        deletedDeviceIds.push(deviceId);
        return json(200, {});
      }
      const keyMatch = req.url?.match(/^\/api\/v2\/tailnet\/-\/keys\/([^/]+)$/);
      if (req.method === "DELETE" && keyMatch !== null && keyMatch !== undefined) {
        deletedKeyIds.push(decodeURIComponent(keyMatch[1]!));
        return json(200, {});
      }
      return json(404, { message: "not found" });
    });
  });

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die("expected a tcp address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    tokenRequests,
    keyRequests,
    deletedDeviceIds,
    deletedKeyIds,
    devices,
  } satisfies FakeApi;
});

const tempDir = Effect.promise(() =>
  NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-tailnet-test-")),
);

const testLayer = (dataDir: string, tailscaleApiUrl: string) =>
  Layer.mergeAll(Tailnet.layer, Layer.empty).pipe(
    Layer.provideMerge(TailnetSettings.layer),
    Layer.provideMerge(Layer.mergeAll(Vault.layer, FetchHttpClient.layer)),
    Layer.provideMerge(Database.layerMemory),
    Layer.provideMerge(ControllerConfig.layer({ ...configDefaults, dataDir, tailscaleApiUrl })),
  );

const configure = Effect.gen(function* () {
  const settings = yield* TailnetSettings;
  return yield* settings.configure({
    clientId: CLIENT_ID,
    clientSecret: Redacted.make(CLIENT_SECRET),
  });
});

const readAllFiles = async (dir: string): Promise<Array<[string, Buffer]>> => {
  const out: Array<[string, Buffer]> = [];
  const entries = await NodeFs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = NodePath.join(entry.parentPath, entry.name);
      out.push([path, await NodeFs.readFile(path)]);
    }
  }
  return out;
};

describe("Tailnet (fake Tailscale API)", () => {
  it.effect("mints tagged keys through the OAuth client, caching the access token", () =>
    Effect.gen(function* () {
      const api = yield* startFakeApi;
      const dataDir = yield* tempDir;
      yield* Effect.gen(function* () {
        yield* configure;
        const tailnet = yield* Tailnet;
        expect(yield* tailnet.configured).toBe(true);

        const first = yield* tailnet.mintAuthKey("env-aaaa1111");
        const second = yield* tailnet.mintAuthKey("env-bbbb2222");
        expect(Redacted.value(first.key)).toBe(MINTED_KEY);
        expect(first.keyId).toBe("key-1");
        expect(second.keyId).toBe("key-2");

        // The exchange used the client-credentials grant, exactly once — the
        // second mint reused the cached access token.
        expect(api.tokenRequests).toHaveLength(1);
        expect(api.tokenRequests[0]!.get("grant_type")).toBe("client_credentials");

        // Non-reusable, non-ephemeral, pre-authorized, tagged, bounded expiry.
        expect(api.keyRequests[0]!.body).toEqual({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: false,
                preauthorized: true,
                tags: [DEFAULT_ENVIRONMENT_TAG],
              },
            },
          },
          expirySeconds: configDefaults.tsAuthKeyTtlSeconds,
          description: "t3fleet env-aaaa1111",
        });
      }).pipe(Effect.provide(testLayer(dataDir, api.url)));
    }).pipe(Effect.scoped),
  );

  it.effect("finds devices by hostname and deletes devices and keys (404 tolerated)", () =>
    Effect.gen(function* () {
      const api = yield* startFakeApi;
      const dataDir = yield* tempDir;
      api.devices.push(
        { id: "101", nodeId: "nodeid-one", hostname: "env-one", name: "env-one.tail1.ts.net" },
        { id: "102", hostname: "env-two", name: "env-two.tail1.ts.net" },
      );
      yield* Effect.gen(function* () {
        yield* configure;
        const tailnet = yield* Tailnet;

        // Hostname matching is case-insensitive; nodeId wins over legacy id.
        const found = yield* tailnet.findDevice("ENV-ONE");
        expect(Option.isSome(found)).toBe(true);
        expect(Option.getOrThrow(found)).toEqual({
          deviceId: "nodeid-one",
          hostname: "env-one",
          name: "env-one.tail1.ts.net",
        });
        // Devices without nodeId fall back to the legacy id.
        const legacy = yield* tailnet.findDevice("env-two");
        expect(Option.getOrThrow(legacy).deviceId).toBe("102");
        expect(Option.isNone(yield* tailnet.findDevice("env-missing"))).toBe(true);

        expect(yield* tailnet.deleteDevice("nodeid-one")).toBe("deleted");
        expect(api.deletedDeviceIds).toEqual(["nodeid-one"]);
        // Deleting an already-gone device is success, not an error.
        expect(yield* tailnet.deleteDevice("nodeid-one")).toBe("not-found");

        expect(yield* tailnet.deleteAuthKey("key-9")).toBe("deleted");
        expect(api.deletedKeyIds).toEqual(["key-9"]);
      }).pipe(Effect.provide(testLayer(dataDir, api.url)));
    }).pipe(Effect.scoped),
  );

  it.effect("fails typed when unconfigured and hides secrets from errors", () =>
    Effect.gen(function* () {
      const api = yield* startFakeApi;
      const dataDir = yield* tempDir;
      yield* Effect.gen(function* () {
        const tailnet = yield* Tailnet;
        expect(yield* tailnet.configured).toBe(false);
        const unconfigured = yield* tailnet.mintAuthKey("env-x").pipe(Effect.flip);
        expect(unconfigured._tag).toBe("TailnetNotConfiguredError");

        // A wrong secret produces a typed API error that carries the HTTP
        // status but never the credential.
        const settings = yield* TailnetSettings;
        yield* settings.configure({
          clientId: CLIENT_ID,
          clientSecret: Redacted.make("tskey-client-wrong-secret"),
        });
        const failure = yield* tailnet.mintAuthKey("env-x").pipe(Effect.flip);
        expect(failure._tag).toBe("TailscaleApiError");
        expect(JSON.stringify(failure)).toContain("401");
        expect(JSON.stringify(failure)).not.toContain("tskey-client-wrong-secret");
      }).pipe(Effect.provide(testLayer(dataDir, api.url)));
    }).pipe(Effect.scoped),
  );

  it.effect("stores the OAuth secret via the vault and replaces it on reconfigure", () =>
    Effect.gen(function* () {
      const api = yield* startFakeApi;
      const dataDir = yield* tempDir;
      yield* Effect.gen(function* () {
        const settings = yield* TailnetSettings;
        const status = yield* configure;
        expect(status).toEqual({
          configured: true,
          clientId: CLIENT_ID,
          tag: DEFAULT_ENVIRONMENT_TAG,
        });

        const firstRef = Option.getOrThrow(yield* settings.read).secretRef;
        expect(firstRef).toMatch(/^sec_/);
        const vault = yield* Vault;
        expect(Redacted.value(yield* vault.read(firstRef))).toBe(CLIENT_SECRET);

        // Reconfiguring replaces the stored secret and removes the old one.
        yield* settings.configure({
          clientId: "kOTHER",
          clientSecret: Redacted.make("tskey-client-kOTHER-newsecret"),
          tag: "tag:custom-env",
        });
        const second = Option.getOrThrow(yield* settings.read);
        expect(second.clientId).toBe("kOTHER");
        expect(second.tag).toBe("tag:custom-env");
        expect(second.secretRef).not.toBe(firstRef);
        const gone = yield* vault.read(firstRef).pipe(Effect.flip);
        expect(gone._tag).toBe("SecretNotFoundError");
      }).pipe(Effect.provide(testLayer(dataDir, api.url)));

      // Neither secret ever rests in plaintext under dataDir.
      const files = yield* Effect.promise(() => readAllFiles(dataDir));
      expect(files.length).toBeGreaterThan(0);
      for (const [, contents] of files) {
        expect(contents.includes(CLIENT_SECRET)).toBe(false);
        expect(contents.includes("tskey-client-kOTHER-newsecret")).toBe(false);
      }
    }).pipe(Effect.scoped),
  );
});
