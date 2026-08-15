import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import {
  PRIVATE_SCOPES,
  classifyAddress,
  expandIpv6,
  validateTarget,
  type AddressScope,
} from '../src/net/ssrf.js';

function resolverFor(
  addresses: readonly { address: string; family: number }[],
): (hostname: string) => Promise<readonly { address: string; family: number }[]> {
  return async () => {
    await Promise.resolve();
    return addresses;
  };
}

async function expectRejected(
  url: string,
  options: Parameters<typeof validateTarget>[1],
  code: string,
  pattern?: RegExp,
): Promise<void> {
  await assert.rejects(
    async () => await validateTarget(url, options),
    (error: unknown) => {
      assert.ok(CrealityError.is(error), `expected CrealityError for ${url}`);
      assert.equal(error.code, code);
      if (pattern !== undefined) assert.match(error.message, pattern);
      return true;
    },
  );
}

describe('classifyAddress — IPv4', () => {
  const cases: readonly [string, AddressScope][] = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.42', 'private'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'shared'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['192.169.1.1', 'public'],
  ];

  for (const [address, scope] of cases) {
    it(`classifies ${address} as ${scope}`, () => {
      assert.equal(classifyAddress(address), scope);
    });
  }

  it('treats malformed input as reserved rather than public', () => {
    assert.equal(classifyAddress('not-an-ip'), 'reserved');
    assert.equal(classifyAddress('999.1.1.1'), 'reserved');
    assert.equal(classifyAddress(''), 'reserved');
  });
});

describe('expandIpv6', () => {
  it('expands a fully written address', () => {
    assert.deepEqual(expandIpv6('2001:0db8:0000:0000:0000:0000:0000:0001'), [
      0x2001, 0x0db8, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('expands compressed forms', () => {
    assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(expandIpv6('fe80::1'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('expands IPv4-mapped addresses', () => {
    assert.deepEqual(expandIpv6('::ffff:192.168.1.42'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x012a]);
  });

  it('ignores a zone index', () => {
    assert.deepEqual(expandIpv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects malformed addresses', () => {
    assert.equal(expandIpv6('1::2::3'), undefined);
    assert.equal(expandIpv6('gggg::1'), undefined);
    assert.equal(expandIpv6('1:2:3'), undefined);
    assert.equal(expandIpv6('1:2:3:4:5:6:7:8:9'), undefined);
  });
});

describe('classifyAddress — IPv6', () => {
  const cases: readonly [string, AddressScope][] = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:4860:4860::8888', 'public'],
    ['::ffff:192.168.1.42', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:127.0.0.1', 'loopback'],
  ];

  for (const [address, scope] of cases) {
    it(`classifies ${address} as ${scope}`, () => {
      assert.equal(classifyAddress(address), scope);
    });
  }
});

describe('PRIVATE_SCOPES', () => {
  it('covers exactly the scopes a LAN printer can occupy', () => {
    assert.deepEqual([...PRIVATE_SCOPES].sort(), ['link-local', 'loopback', 'private', 'shared']);
  });

  it('excludes public and every degenerate scope', () => {
    for (const scope of ['public', 'multicast', 'broadcast', 'reserved', 'unspecified'] as const) {
      assert.equal(PRIVATE_SCOPES.has(scope), false, `${scope} must not be treated as private`);
    }
  });
});

describe('validateTarget — accepted targets', () => {
  it('accepts a private IPv4 literal without touching DNS', async () => {
    const target = await validateTarget('http://192.168.1.42:7125');
    assert.equal(target.hostname, '192.168.1.42');
    assert.equal(target.port, 7125);
    assert.equal(target.protocol, 'http:');
    assert.equal(target.literal, true);
    assert.equal(target.pinnedAddress.scope, 'private');
  });

  it('accepts loopback', async () => {
    const target = await validateTarget('http://127.0.0.1:7125');
    assert.equal(target.pinnedAddress.scope, 'loopback');
  });

  it('accepts a bracketed IPv6 literal', async () => {
    const target = await validateTarget('http://[fd00::1]:7125');
    assert.equal(target.hostname, 'fd00::1');
    assert.equal(target.pinnedAddress.family, 6);
    assert.equal(target.pinnedAddress.scope, 'private');
  });

  it('resolves a hostname to a private address', async () => {
    const target = await validateTarget('http://printer.local:7125', {
      resolver: resolverFor([{ address: '192.168.1.42', family: 4 }]),
    });
    assert.equal(target.literal, false);
    assert.equal(target.pinnedAddress.address, '192.168.1.42');
  });

  it('infers the default port per protocol', async () => {
    assert.equal((await validateTarget('http://192.168.1.42')).port, 80);
    assert.equal((await validateTarget('https://192.168.1.42')).port, 443);
  });

  it('allows a public address only when explicitly opted in', async () => {
    const options = { resolver: resolverFor([{ address: '8.8.8.8', family: 4 }]) };
    await expectRejected('http://printer.example.com', options, 'HOST_NOT_ALLOWED');
    const target = await validateTarget('http://printer.example.com', {
      ...options,
      allowPublicNetwork: true,
    });
    assert.equal(target.pinnedAddress.scope, 'public');
  });
});

describe('validateTarget — refusals', () => {
  it('refuses a public address by default, and says how to opt in', async () => {
    await expectRejected(
      'http://printer.example.com',
      { resolver: resolverFor([{ address: '93.184.216.34', family: 4 }]) },
      'HOST_NOT_ALLOWED',
      /outside the private network/,
    );
  });

  it('always refuses the cloud metadata endpoint, even with public access enabled', async () => {
    await expectRejected(
      'http://metadata.internal',
      {
        allowPublicNetwork: true,
        resolver: resolverFor([{ address: '169.254.169.254', family: 4 }]),
      },
      'HOST_NOT_ALLOWED',
      /metadata endpoint/,
    );
  });

  it('refuses the IPv6 metadata endpoint', async () => {
    await expectRejected(
      'http://[fd00:ec2::254]:80',
      { allowPublicNetwork: true },
      'HOST_NOT_ALLOWED',
      /metadata endpoint/,
    );
  });

  it('refuses non-HTTP protocols', async () => {
    for (const url of ['ftp://192.168.1.42', 'file:///etc/passwd', 'gopher://192.168.1.42']) {
      await expectRejected(url, {}, 'HOST_NOT_ALLOWED', /Only http\(s\)/);
    }
  });

  it('refuses embedded credentials', async () => {
    await expectRejected(
      'http://user:pass@192.168.1.42:7125',
      {},
      'HOST_NOT_ALLOWED',
      /must not embed credentials/,
    );
  });

  it('refuses a malformed URL', async () => {
    await expectRejected('not a url', {}, 'CONFIG_INVALID', /not a valid URL/);
  });

  it('refuses a host outside the allowlist', async () => {
    await expectRejected(
      'http://192.168.1.99:7125',
      { allowedHosts: ['192.168.1.42'] },
      'HOST_NOT_ALLOWED',
      /not in the configured allowlist/,
    );
  });

  it('accepts a host on the allowlist', async () => {
    const target = await validateTarget('http://192.168.1.42:7125', {
      allowedHosts: ['192.168.1.42'],
    });
    assert.equal(target.hostname, '192.168.1.42');
  });

  it('supports suffix entries in the allowlist', async () => {
    const options = {
      allowedHosts: ['.local'],
      resolver: resolverFor([{ address: '192.168.1.42', family: 4 }]),
    };
    await assert.doesNotReject(async () => await validateTarget('http://printer.local', options));
    await expectRejected('http://printer.example.com', options, 'HOST_NOT_ALLOWED');
  });

  it('refuses when every resolved address is disallowed, even if one is private', async () => {
    // A rebinding answer mixing a safe and an unsafe address must not slip through.
    await expectRejected(
      'http://printer.local',
      {
        resolver: resolverFor([
          { address: '192.168.1.42', family: 4 },
          { address: '8.8.8.8', family: 4 },
        ]),
      },
      'HOST_NOT_ALLOWED',
      /outside the private network/,
    );
  });

  it('reports a resolution failure as a retryable network error', async () => {
    await assert.rejects(
      async () =>
        await validateTarget('http://printer.local', {
          resolver: () => Promise.reject(new Error('ENOTFOUND')),
        }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'NETWORK');
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('refuses a host that resolves to nothing', async () => {
    await expectRejected(
      'http://printer.local',
      { resolver: resolverFor([]) },
      'NETWORK',
      /resolved to no addresses/,
    );
  });
});
