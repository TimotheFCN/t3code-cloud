/**
 * The single seam where environment endpoint URLs are built.
 *
 * Phase 3 reaches environments through a node-port mapping
 * (`http://<node-host>:<host-port>`). Phase 4 replaces this construction with
 * per-environment tailnet HTTPS URLs (`https://env-<id>.<tailnet>.ts.net`)
 * and deletes the node-port path; everything else consumes the persisted
 * `endpoint_url` and needs no change.
 */
export const nodePortEndpoint = (host: string, hostPort: number): string =>
  host.includes(":") ? `http://[${host}]:${hostPort}` : `http://${host}:${hostPort}`;

/** `<origin>/pair#token=<credential>` — upstream's pairing URL format. */
export const pairingUrl = (endpointUrl: string, credential: string): string =>
  `${endpointUrl.replace(/\/$/, "")}/pair#token=${encodeURIComponent(credential)}`;
