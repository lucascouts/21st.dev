/**
 * Fetch URL guard for the logo pipeline (story 005 — R3.1 to R3.3).
 *
 * One predicate, applied to a URL STRING before the SVG request leaves the
 * process. It answers a single question — may this URL be fetched? — and it
 * answers it from the URL AS WRITTEN. No DNS is resolved: rebinding is
 * story.md Assumption 3 and is explicitly out of scope here, so a name that
 * resolves to a private address is not something this module can see.
 *
 * Three properties are load-bearing, and each was measured on Bun 1.3.14
 * rather than assumed:
 *
 * 1. The scheme is checked FIRST, so no range check ever sees a non-`https`
 *    URL. That one test removes `http:`, `file:`, `data:`, `javascript:`,
 *    `ftp:`, `ws:` and every other scheme at once, and it removes them by
 *    naming what is allowed rather than by listing what is not.
 * 2. WHATWG parsing REWRITES an IPv4-mapped IPv6 host into its hex form:
 *    `https://[::ffff:127.0.0.1]` has `hostname === "[::ffff:7f00:1]"`. A
 *    check matching on the literal source text therefore misses the single
 *    most common way to write a loopback address in v6 form. The mapped
 *    prefix is detected structurally (first five groups zero, sixth `ffff`)
 *    and the embedded v4 address is run through the v4 ranges, so both
 *    spellings refuse identically. Measured likewise: `[::ffff:10.0.0.1]`
 *    becomes `[::ffff:a00:1]`, `[::ffff:169.254.169.254]` becomes
 *    `[::ffff:a9fe:a9fe]`. The deprecated IPv4-COMPATIBLE prefix `::/96` is
 *    read the same way, for the reason given on `embeddedIpv4Of`.
 * 3. The refusal reason is built from the HOST, never from the URL. The
 *    userinfo component can carry credentials —
 *    `https://admin:s3cr3t-token@127.0.0.1/` — and the path and query can
 *    carry a token just as easily, so R3.3 forbids logging the URL. Building
 *    the reason here means no call site has to remember that; it logs what
 *    the guard hands it.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - The refusal is for the `localhost` TLD, not for the substring.
 *   `localhost.example.com` is an ordinary public name and is ALLOWED;
 *   `foo.localhost` is reserved for loopback (RFC 6761) and is refused.
 * - Every blocked v4 range is a RANGE, compared under its netmask, not a
 *   string prefix. `172.16.0.0/12` covers `172.16.0.0` through
 *   `172.31.255.255` and nothing else, so `172.15.0.1` and `172.32.0.1` are
 *   allowed while `172.31.255.254` is not.
 *
 * What this does NOT cover, stated rather than implied: DNS rebinding (above),
 * and NAT64. A `64:ff9b::/96` address (RFC 6052) denotes a v4 address too, but
 * only reaches it through a translating gateway, and RFC 6052 also permits
 * network-specific prefixes of /32 to /96 that no static list can enumerate —
 * so covering it is a policy decision for the story that has such a gateway,
 * not a gap this module can close honestly.
 *
 * The function is total: every input returns a result and no path raises.
 * Anything unparseable, unrecognised or unexpected is REFUSED — falling open
 * is the failure mode this module exists to remove.
 */

/** The verdict for one URL. `reason` is empty exactly when `allowed` is true. */
export interface UrlGuardResult {
  readonly allowed: boolean;
  /**
   * Why the URL was refused, built from the host. Safe to log: it never
   * contains the URL's userinfo, path or query (R3.3). Empty when allowed.
   */
  readonly reason: string;
}

/** Frozen because it is shared by every allowing path, not rebuilt per call. */
const ALLOWED: UrlGuardResult = Object.freeze({ allowed: true, reason: "" });

function refuse(reason: string): UrlGuardResult {
  return { allowed: false, reason };
}

/**
 * Refuse, naming the host and nothing else.
 *
 * Every host-bearing reason is built here, so R3.3 — no userinfo, no path, no
 * query in the log — holds by construction rather than by each call site
 * remembering. `host` is always a parsed `URL.hostname`, which excludes the
 * userinfo the credential could hide in.
 */
function refuseHost(host: string, detail: string): UrlGuardResult {
  return refuse(`Refused host "${host}": ${detail}`);
}

/** The only scheme an SVG may be fetched over (R3.1). */
const ALLOWED_SCHEME = "https:";

/** The loopback TLD reserved by RFC 6761, including the leading dot. */
const LOOPBACK_TLD_SUFFIX = ".localhost";

/** The bare loopback name. */
const LOOPBACK_NAME = "localhost";

interface BlockedIpv4Range {
  /** Human form, e.g. `127.0.0.0/8`. Reported in the refusal reason. */
  readonly cidr: string;
  /** Why the range is blocked, e.g. `loopback`. */
  readonly why: string;
  /** Network address, packed big-endian into an unsigned 32-bit integer. */
  readonly network: number;
  /** Netmask for the prefix, packed the same way. */
  readonly mask: number;
}

function ipv4Range(
  a: number,
  b: number,
  c: number,
  d: number,
  prefixBits: number,
  why: string,
): BlockedIpv4Range {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return {
    cidr: `${a}.${b}.${c}.${d}/${prefixBits}`,
    why,
    // `>>> 0` is not decoration: `&` yields a SIGNED int32, so without it every
    // network from 128.0.0.0 up is stored negative and can never equal the
    // unsigned value it is compared against.
    network: (packIpv4([a, b, c, d]) & mask) >>> 0,
    mask,
  };
}

/**
 * The v4 ranges design.md enumerates: loopback, link-local, private and
 * otherwise reserved. An IPv6 address carrying an embedded v4 address is
 * checked against this same table, so no spelling of an address can disagree
 * with another about whether it is blocked.
 */
const BLOCKED_IPV4_RANGES: readonly BlockedIpv4Range[] = [
  ipv4Range(0, 0, 0, 0, 8, "unspecified"),
  ipv4Range(10, 0, 0, 0, 8, "private"),
  ipv4Range(100, 64, 0, 0, 10, "carrier-grade NAT"),
  ipv4Range(127, 0, 0, 0, 8, "loopback"),
  ipv4Range(169, 254, 0, 0, 16, "link-local"),
  ipv4Range(172, 16, 0, 0, 12, "private"),
  ipv4Range(192, 0, 0, 0, 24, "reserved"),
  ipv4Range(192, 168, 0, 0, 16, "private"),
  ipv4Range(198, 18, 0, 0, 15, "benchmarking"),
  ipv4Range(224, 0, 0, 0, 4, "multicast"),
  ipv4Range(240, 0, 0, 0, 4, "reserved"),
];

/**
 * Report whether `url` may be fetched (R3.1, R3.2).
 *
 * Total by construction: it never raises, for any input, and it refuses
 * anything it cannot fully understand.
 */
export function checkFetchUrl(url: string): UrlGuardResult {
  try {
    return evaluate(url);
  } catch {
    // Unreachable by design. Kept because a guard that raises is a guard the
    // caller can fall past, which is the outcome this module rules out.
    return refuse("URL could not be evaluated");
  }
}

function evaluate(url: string): UrlGuardResult {
  if (typeof url !== "string") {
    return refuse("URL is not a string");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL itself is withheld: an unparseable string can still hold a
    // credential, and this reason is written to the log (R3.3).
    return refuse("URL could not be parsed");
  }

  // Scheme first, so no range check ever sees a non-https URL.
  if (parsed.protocol !== ALLOWED_SCHEME) {
    const scheme = `Refused scheme "${parsed.protocol}"`;
    const where = parsed.hostname.length > 0 ? ` for host "${parsed.hostname}"` : "";
    return refuse(`${scheme}${where}: only https is permitted`);
  }

  return checkHost(parsed.hostname);
}

function checkHost(hostname: string): UrlGuardResult {
  const host = hostname.toLowerCase();

  if (host.length === 0) {
    return refuse("Refused URL with an empty host");
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    return checkIpv6Host(host);
  }

  // A trailing dot is the absolute form of the same name: WHATWG keeps it
  // (`https://localhost./` has hostname `localhost.`), so it is stripped
  // before the name comparison rather than left as a bypass.
  const name = stripTrailingDots(host);

  const octets = parseIpv4(name);
  if (octets !== null) {
    return checkIpv4Address(host, octets, "address");
  }

  if (name === LOOPBACK_NAME || name.endsWith(LOOPBACK_TLD_SUFFIX)) {
    return refuseHost(host, "loopback name");
  }

  return ALLOWED;
}

function checkIpv6Host(host: string): UrlGuardResult {
  const groups = parseIpv6(host.slice(1, -1));
  if (groups === null) {
    // Fail closed: an address this module cannot read is one whose range it
    // cannot check.
    return refuseHost(host, "not a readable IPv6 literal");
  }

  // The named v6 ranges come first purely for the reason they produce: `::`
  // and `::1` also carry an embedded v4 address, and "::1/128 (loopback)"
  // tells an operator more than "0.0.0.0/8". Neither can be reached by the
  // embedded-v4 branch below, which requires a sixth group of `0` or `ffff`
  // that these two already exclude.
  const blocked = blockedIpv6Range(groups);
  if (blocked !== null) {
    return refuseHost(host, `address in the blocked range ${blocked}`);
  }

  const embedded = embeddedIpv4Of(groups);
  if (embedded !== null) {
    return checkIpv4Address(host, embedded.octets, `${embedded.form} address`);
  }

  return ALLOWED;
}

/**
 * Check four octets against every blocked v4 range. `form` names how the
 * address was written, so an operator reading the log can tell a plain
 * `127.0.0.1` from the same address arriving as `[::ffff:7f00:1]`.
 */
function checkIpv4Address(
  host: string,
  octets: readonly number[],
  form: string,
): UrlGuardResult {
  const address = packIpv4(octets);

  for (const range of BLOCKED_IPV4_RANGES) {
    if (contains(range, address)) {
      return refuseHost(host, `${form} in the blocked range ${range.cidr} (${range.why})`);
    }
  }

  return ALLOWED;
}

function contains(range: BlockedIpv4Range, address: number): boolean {
  return ((address & range.mask) >>> 0) === range.network;
}

/** The v6 ranges design.md enumerates, plus the unspecified address `::`. */
function blockedIpv6Range(groups: readonly number[]): string | null {
  if (groups.every((group) => group === 0)) {
    return "::/128 (unspecified)";
  }

  const isLoopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isLoopback) {
    return "::1/128 (loopback)";
  }

  const first = groups[0];
  if ((first & 0xffc0) === 0xfe80) {
    return "fe80::/10 (link-local)";
  }
  if ((first & 0xfe00) === 0xfc00) {
    return "fc00::/7 (unique local)";
  }

  return null;
}

interface EmbeddedIpv4 {
  readonly octets: number[];
  /** How the v4 address was written, for the refusal reason. */
  readonly form: string;
}

/**
 * The v4 address embedded in an IPv6 address, or null when there is none.
 *
 * Two prefixes carry one, and both are checked against the SAME v4 table, so a
 * v4 address cannot change its verdict by changing its spelling:
 *
 * - `::ffff:0:0/96`, IPv4-mapped. The one design.md names, and the reason
 *   `[::ffff:127.0.0.1]` refuses exactly as `127.0.0.1` does.
 * - `::/96`, IPv4-compatible (deprecated, RFC 4291 section 2.5.5.1). Not named
 *   by design.md, added here after measuring it: `https://[::ffff:]/logo.svg`
 *   parses to the host `[::ffff]`, which is `0.0.255.255` — an address
 *   design.md ALREADY refuses under `0.0.0.0/8` in its v4 spelling. Reading
 *   the embedded address is not new policy, it is the existing policy made
 *   independent of how the address was typed, and it over-blocks nothing:
 *   `[::8.8.8.8]` embeds a public address and stays allowed.
 */
function embeddedIpv4Of(groups: readonly number[]): EmbeddedIpv4 | null {
  if (!groups.slice(0, 5).every((group) => group === 0)) {
    return null;
  }

  const octets = [groups[6] >>> 8, groups[6] & 0xff, groups[7] >>> 8, groups[7] & 0xff];

  if (groups[5] === 0xffff) {
    return { octets, form: "IPv4-mapped" };
  }
  if (groups[5] === 0) {
    return { octets, form: "IPv4-compatible" };
  }

  return null;
}

const IPV4_OCTET = /^[0-9]{1,3}$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/** Four dotted decimal octets, or null when `text` is not one. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }

  return octets;
}

/**
 * Eight 16-bit groups, or null when `text` is not a readable IPv6 address.
 * Handles `::` compression and a trailing dotted-quad; the parsed hostname
 * only ever uses the former, the latter costs two lines and removes a way to
 * be wrong.
 */
function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }

  if (halves.length === 1) {
    const groups = parseIpv6Groups(halves[0]);
    return groups !== null && groups.length === 8 ? groups : null;
  }

  const head = parseIpv6Groups(halves[0]);
  const tail = parseIpv6Groups(halves[1]);
  if (head === null || tail === null) {
    return null;
  }

  const elided = 8 - head.length - tail.length;
  if (elided < 1) {
    return null;
  }

  return [...head, ...new Array<number>(elided).fill(0), ...tail];
}

function parseIpv6Groups(part: string): number[] | null {
  if (part.length === 0) {
    return [];
  }

  const tokens = part.split(":");
  const groups: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (index === tokens.length - 1 && token.includes(".")) {
      const octets = parseIpv4(token);
      if (octets === null) {
        return null;
      }
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }

    if (!IPV6_GROUP.test(token)) {
      return null;
    }
    groups.push(Number.parseInt(token, 16));
  }

  return groups;
}

/** Pack four octets big-endian into an unsigned 32-bit integer. */
function packIpv4(octets: readonly number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") {
    end -= 1;
  }
  return host.slice(0, end);
}
