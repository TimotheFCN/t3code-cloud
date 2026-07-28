/**
 * The single seam where environment endpoint URLs are built.
 *
 * Every environment is its own tailnet device; its endpoint is the MagicDNS
 * HTTPS URL derived from the device name the Tailscale API reports after the
 * first join (`https://env-<id>.<tailnet>.ts.net`). The scheme is
 * configurable only so integration tests can fake the tailnet with plain
 * HTTP — production is always `https`.
 */
export const tailnetEndpoint = (scheme: "https" | "http", deviceName: string): string =>
  `${scheme}://${deviceName.replace(/\.$/, "").toLowerCase()}`;

/** `<origin>/pair#token=<credential>` — upstream's pairing URL format. */
export const pairingUrl = (endpointUrl: string, credential: string): string =>
  `${endpointUrl.replace(/\/$/, "")}/pair#token=${encodeURIComponent(credential)}`;
