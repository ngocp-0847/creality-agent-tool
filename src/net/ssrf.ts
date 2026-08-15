/**
 * SSRF and private-network validation.
 *
 * A printer lives on your LAN. This module enforces that assumption: the target
 * URL must be plain HTTP(S) with no credentials, and every address the hostname
 * resolves to must sit in a loopback / private / link-local range — unless the
 * operator has explicitly opted into public targets.
 *
 * Resolution results are returned so the caller can *pin* the connection to a
 * validated address, which closes the DNS-rebinding window between the check
 * and the connect.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { CrealityError } from '../errors.js';

export type AddressScope =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'public'
  | 'unspecified'
  | 'multicast'
  | 'broadcast'
  | 'reserved';

export const PRIVATE_SCOPES: ReadonlySet<AddressScope> = new Set<AddressScope>([
  'loopback',
  'private',
  'link-local',
  'shared',
]);

/** Endpoints that are technically link-local but are well-known SSRF targets. */
const ALWAYS_DENIED_ADDRESSES: ReadonlySet<string> = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
]);

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
  readonly scope: AddressScope;
}

export interface ValidatedTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  readonly protocol: 'http:' | 'https:';
  readonly addresses: readonly ResolvedAddress[];
  /** The address a connection should be pinned to. */
  readonly pinnedAddress: ResolvedAddress;
  /** True when the hostname was an IP literal (no DNS involved). */
  readonly literal: boolean;
}

export interface ValidateTargetOptions {
  readonly allowPublicNetwork?: boolean;
  readonly allowedHosts?: readonly string[];
  /** Injected for tests. */
  readonly resolver?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}

function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function classifyIpv4(address: string): AddressScope {
  const octets = parseIpv4(address);
  if (octets === undefined) return 'reserved';
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

/** Expand an IPv6 address to its eight 16-bit groups; undefined if malformed. */
export function expandIpv6(address: string): readonly number[] | undefined {
  let text = address.trim().toLowerCase();
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const embedded = lastColon === -1 ? '' : text.slice(lastColon + 1);
  if (embedded.includes('.')) {
    const octets = parseIpv4(embedded);
    if (octets === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    tail = [(a << 8) | b, (c << 8) | d];
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return undefined;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? '');
  if (head === undefined) return undefined;
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    return tail.length === 0 ? head : [...head.slice(0, 6), ...tail];
  }
  const rest = toGroups(halves[1] ?? '');
  if (rest === undefined) return undefined;
  const missing = 8 - head.length - rest.length;
  if (missing < 0) return undefined;
  const groups = [...head, ...Array.from({ length: missing }, () => 0), ...rest];
  return tail.length === 0 ? groups : [...groups.slice(0, 6), ...tail];
}

function classifyIpv6(address: string): AddressScope {
  const groups = expandIpv6(address);
  if (groups === undefined) return 'reserved';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: classify by the embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    if (g5 === 0 && g6 === 0 && g7 === 1) return 'loopback';
    if (g5 === 0 && g6 === 0 && g7 === 0) return 'unspecified';
    return classifyIpv4(embedded);
  }
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

export function classifyAddress(address: string): AddressScope {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return 'reserved';
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some(
    (entry) => host === entry || (entry.startsWith('.') && host.endsWith(entry)),
  );
}

/**
 * Validate a printer base URL. Throws `HOST_NOT_ALLOWED` / `CONFIG_INVALID` /
 * `NETWORK` rather than returning a boolean, so misconfiguration is loud.
 */
export async function validateTarget(
  rawUrl: string,
  options: ValidateTargetOptions = {},
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new CrealityError('CONFIG_INVALID', `Printer URL is not a valid URL: "${rawUrl}".`, {
      cause,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CrealityError(
      'HOST_NOT_ALLOWED',
      `Only http(s) printer URLs are supported (got "${url.protocol}").`,
      { details: { protocol: url.protocol } },
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new CrealityError(
      'HOST_NOT_ALLOWED',
      'Printer URL must not embed credentials; use CREALITY_API_KEY instead.',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') {
    throw new CrealityError('CONFIG_INVALID', 'Printer URL has no host.');
  }
  const allowedHosts = options.allowedHosts ?? [];
  if (!hostAllowed(hostname, allowedHosts)) {
    throw new CrealityError(
      'HOST_NOT_ALLOWED',
      `Host "${hostname}" is not in the configured allowlist.`,
      { details: { hostname, allowedHosts } },
    );
  }

  const literalFamily = isIP(hostname);
  let candidates: readonly { address: string; family: number }[];
  if (literalFamily !== 0) {
    candidates = [{ address: hostname, family: literalFamily }];
  } else {
    const resolver = options.resolver ?? defaultResolver;
    try {
      candidates = await resolver(hostname);
    } catch (cause) {
      throw new CrealityError('NETWORK', `Could not resolve printer host "${hostname}".`, {
        cause,
        details: { hostname },
        retryable: true,
      });
    }
    if (candidates.length === 0) {
      throw new CrealityError('NETWORK', `Host "${hostname}" resolved to no addresses.`, {
        details: { hostname },
      });
    }
  }

  const allowPublic = options.allowPublicNetwork ?? false;
  const addresses: ResolvedAddress[] = candidates.map((candidate) => ({
    address: candidate.address,
    family: candidate.family === 6 ? 6 : 4,
    scope: classifyAddress(candidate.address),
  }));

  for (const resolved of addresses) {
    if (ALWAYS_DENIED_ADDRESSES.has(resolved.address.toLowerCase())) {
      throw new CrealityError(
        'HOST_NOT_ALLOWED',
        `Address ${resolved.address} is a cloud metadata endpoint and is always blocked.`,
        { details: { hostname, address: resolved.address } },
      );
    }
    const routable = resolved.scope === 'public';
    const usable = PRIVATE_SCOPES.has(resolved.scope) || (allowPublic && routable);
    if (!usable) {
      throw new CrealityError(
        'HOST_NOT_ALLOWED',
        allowPublic
          ? `Address ${resolved.address} (${resolved.scope}) is not a valid printer endpoint.`
          : `Host "${hostname}" resolves to ${resolved.address} (${resolved.scope}), which is outside the private network. ` +
            'Set CREALITY_ALLOW_PUBLIC_NETWORK=true only if you intend to reach a printer beyond your LAN.',
        { details: { hostname, address: resolved.address, scope: resolved.scope } },
      );
    }
  }

  const pinnedAddress = addresses[0];
  /* c8 ignore next */
  if (pinnedAddress === undefined) {
    throw new CrealityError('NETWORK', `Host "${hostname}" resolved to no usable addresses.`);
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  return {
    url,
    hostname,
    port,
    protocol: url.protocol === 'https:' ? 'https:' : 'http:',
    addresses,
    pinnedAddress,
    literal: literalFamily !== 0,
  };
}

async function defaultResolver(
  hostname: string,
): Promise<readonly { address: string; family: number }[]> {
  return await lookup(hostname, { all: true, verbatim: true });
}
