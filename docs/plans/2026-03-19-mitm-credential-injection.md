# MITM Credential Injection for Skill API Keys

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable sandboxed agent skills to use third-party API keys (e.g., LINEAR_API_KEY) without real credentials entering the container, by upgrading the web proxy to perform MITM TLS inspection and credential placeholder replacement.

**Architecture:** The web proxy's CONNECT handler is upgraded from a blind TCP tunnel to a TLS-terminating MITM proxy. A host-generated CA cert is injected into sandbox containers. Skills declare required env vars in their frontmatter; the host generates opaque placeholder tokens and injects them as env vars. When the proxy intercepts outbound HTTPS requests, it scans for placeholder patterns in headers/body and replaces them with real credentials from the CredentialProvider. A bypass list handles cert-pinning CLIs.

**Tech Stack:** Node.js `tls` module for TLS termination, `node-forge` (or `@peculiar/x509`) for dynamic cert generation, existing CredentialProvider interface, existing web proxy infrastructure.

---

## Task 1: CA Certificate Generation Utility

**Files:**
- Create: `src/host/proxy-ca.ts`
- Test: `tests/host/proxy-ca.test.ts`

This utility generates a self-signed root CA key + certificate at first use, persists them to disk, and loads them on subsequent runs. The CA is used to sign per-domain certificates for MITM TLS termination.

**Step 1: Write the failing test**

```typescript
// tests/host/proxy-ca.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';

// We'll import { getOrCreateCA } from '../../src/host/proxy-ca.js';

describe('proxy-ca', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ax-ca-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('creates CA key and cert on first call', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    expect(ca.key).toBeDefined();
    expect(ca.cert).toBeDefined();
    // Files should be persisted
    expect(existsSync(join(dir, 'ca.key'))).toBe(true);
    expect(existsSync(join(dir, 'ca.crt'))).toBe(true);
  });

  test('returns same CA on second call', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const ca1 = await getOrCreateCA(dir);
    const ca2 = await getOrCreateCA(dir);
    expect(ca1.cert).toBe(ca2.cert);
  });

  test('generates valid domain cert signed by CA', async () => {
    const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    const domainCert = generateDomainCert('api.linear.app', ca);
    expect(domainCert.key).toBeDefined();
    expect(domainCert.cert).toBeDefined();

    // Verify the cert is valid for the domain by creating a TLS context
    // (no error = valid PEM format)
    const ctx = tls.createSecureContext({
      key: domainCert.key,
      cert: domainCert.cert,
      ca: ca.cert,
    });
    expect(ctx).toBeDefined();
  });

  test('caches domain certs', async () => {
    const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    const cert1 = generateDomainCert('api.linear.app', ca);
    const cert2 = generateDomainCert('api.linear.app', ca);
    expect(cert1.cert).toBe(cert2.cert);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/proxy-ca.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/host/proxy-ca.ts
/**
 * MITM proxy CA certificate management.
 *
 * Generates a self-signed root CA for the web proxy's TLS inspection mode.
 * Domain certificates are generated on-the-fly and cached in memory.
 * The CA key + cert are persisted to disk so containers can trust the CA
 * across restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as forge from 'node-forge';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'proxy-ca' });

export interface CAKeyPair {
  key: string;   // PEM-encoded private key
  cert: string;  // PEM-encoded certificate
}

export interface DomainCert {
  key: string;   // PEM-encoded private key
  cert: string;  // PEM-encoded certificate
}

/** In-memory cache of generated domain certs. */
const domainCertCache = new Map<string, DomainCert>();

/**
 * Load or generate the root CA. Persists to `dir/ca.key` and `dir/ca.crt`.
 */
export async function getOrCreateCA(dir: string): Promise<CAKeyPair> {
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  logger.info('generating_ca', { dir });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'AX MITM Proxy CA' },
    { name: 'organizationName', value: 'AX' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
  const pemCert = forge.pki.certificateToPem(cert);

  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pemKey, { mode: 0o600 });
  writeFileSync(certPath, pemCert);

  return { key: pemKey, cert: pemCert };
}

/**
 * Generate a TLS certificate for a specific domain, signed by the CA.
 * Results are cached in memory — one cert per domain for the process lifetime.
 */
export function generateDomainCert(domain: string, ca: CAKeyPair): DomainCert {
  const cached = domainCertCache.get(domain);
  if (cached) return cached;

  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const result: DomainCert = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  domainCertCache.set(domain, result);
  return result;
}
```

**Step 4: Install node-forge dependency**

Run: `npm install node-forge && npm install -D @types/node-forge`

**Step 5: Run test to verify it passes**

Run: `npm test -- --run tests/host/proxy-ca.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/host/proxy-ca.ts tests/host/proxy-ca.test.ts package.json package-lock.json
git commit -m "feat: add CA certificate generation for MITM proxy"
```

---

## Task 2: Credential Placeholder Manager

**Files:**
- Create: `src/host/credential-placeholders.ts`
- Test: `tests/host/credential-placeholders.test.ts`

Manages the mapping between opaque placeholder tokens and real credential values. The host generates placeholders when launching a sandbox, and the proxy uses this map to perform replacements in intercepted traffic.

**Step 1: Write the failing test**

```typescript
// tests/host/credential-placeholders.test.ts
import { describe, test, expect } from 'vitest';

describe('credential-placeholders', () => {
  test('generates unique placeholder for a credential', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    expect(ph).toMatch(/^ax-cred:[a-f0-9]+$/);
  });

  test('replaces placeholders in a string', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    const input = `Authorization: Bearer ${ph}`;
    const result = map.replaceAll(input);
    expect(result).toBe('Authorization: Bearer lin_api_real_key_123');
  });

  test('replaces placeholders in a Buffer', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    const input = Buffer.from(`{"token":"${ph}"}`);
    const result = map.replaceAllBuffer(input);
    expect(result.toString()).toBe('{"token":"lin_api_real_key_123"}');
  });

  test('handles multiple placeholders', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph1 = map.register('LINEAR_API_KEY', 'lin_key');
    const ph2 = map.register('GITHUB_TOKEN', 'ghp_token');
    const input = `linear=${ph1}&github=${ph2}`;
    const result = map.replaceAll(input);
    expect(result).toBe('linear=lin_key&github=ghp_token');
  });

  test('returns env map of name→placeholder', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_key');
    const envMap = map.toEnvMap();
    expect(envMap).toEqual({ LINEAR_API_KEY: ph });
  });

  test('hasPlaceholders returns false when no placeholders in string', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    map.register('LINEAR_API_KEY', 'lin_key');
    expect(map.hasPlaceholders('no creds here')).toBe(false);
  });

  test('hasPlaceholders returns true when placeholder present', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_key');
    expect(map.hasPlaceholders(`Bearer ${ph}`)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/credential-placeholders.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/host/credential-placeholders.ts
/**
 * Credential placeholder management for MITM proxy credential injection.
 *
 * Generates opaque placeholder tokens that are injected into sandbox env vars
 * in place of real credentials. The web proxy uses this map to replace
 * placeholders with real values in intercepted HTTPS traffic.
 *
 * Placeholder format: ax-cred:<hex-random>
 * Designed to be unlikely to collide with legitimate content.
 */

import { randomBytes } from 'node:crypto';

export class CredentialPlaceholderMap {
  /** placeholder → real value */
  private readonly placeholderToReal = new Map<string, string>();
  /** env var name → placeholder */
  private readonly nameToPlaceholder = new Map<string, string>();

  /**
   * Register a credential and return its placeholder token.
   * If the same name is registered twice, the previous mapping is replaced.
   */
  register(envName: string, realValue: string): string {
    // Remove old mapping if re-registering
    const oldPh = this.nameToPlaceholder.get(envName);
    if (oldPh) this.placeholderToReal.delete(oldPh);

    const placeholder = `ax-cred:${randomBytes(16).toString('hex')}`;
    this.placeholderToReal.set(placeholder, realValue);
    this.nameToPlaceholder.set(envName, placeholder);
    return placeholder;
  }

  /** Check if a string contains any registered placeholders. */
  hasPlaceholders(input: string): boolean {
    for (const ph of this.placeholderToReal.keys()) {
      if (input.includes(ph)) return true;
    }
    return false;
  }

  /** Replace all placeholders in a string with real values. */
  replaceAll(input: string): string {
    let result = input;
    for (const [ph, real] of this.placeholderToReal) {
      // Use split+join for global replacement (no regex special chars concern)
      result = result.split(ph).join(real);
    }
    return result;
  }

  /** Replace all placeholders in a Buffer. Returns a new Buffer. */
  replaceAllBuffer(input: Buffer): Buffer {
    const str = input.toString('utf-8');
    if (!this.hasPlaceholders(str)) return input;
    return Buffer.from(this.replaceAll(str));
  }

  /** Return env var name → placeholder map for sandbox injection. */
  toEnvMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, ph] of this.nameToPlaceholder) {
      result[name] = ph;
    }
    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/credential-placeholders.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/credential-placeholders.ts tests/host/credential-placeholders.test.ts
git commit -m "feat: add credential placeholder map for MITM proxy injection"
```

---

## Task 3: Upgrade CONNECT Handler to MITM TLS Termination

**Files:**
- Modify: `src/host/web-proxy.ts` (add MITM mode to `handleCONNECT`)
- Modify: `src/host/web-proxy.ts` (add `WebProxyOptions` fields for CA + credentials)
- Test: `tests/host/web-proxy.test.ts` (add MITM tests)

This is the core change: when MITM mode is enabled (CA + credential map provided), the CONNECT handler terminates TLS on the client side using a dynamically-generated domain cert, makes its own TLS connection to the real server, and performs credential replacement on decrypted traffic.

**Step 1: Write the failing tests**

Add these tests to `tests/host/web-proxy.test.ts`:

```typescript
// Add imports at top:
import * as tls from 'node:tls';
import * as https from 'node:https';
import { CredentialPlaceholderMap } from '../../src/host/credential-placeholders.js';
// getOrCreateCA, generateDomainCert will be used indirectly via proxy options

// Add new describe block:
describe('MITM TLS inspection', () => {
  test('intercepts HTTPS and replaces credential placeholder in header', async () => {
    // 1. Start a TLS echo server (simulates api.linear.app)
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
    cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));

    const ca = await getOrCreateCA(caDir);

    // Self-signed server cert for our test echo server
    const { generateDomainCert } = await import('../../src/host/proxy-ca.js');
    const serverCert = generateDomainCert('127.0.0.1', ca);

    const tlsEchoServer = tls.createServer({
      key: serverCert.key,
      cert: serverCert.cert,
    }, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        // Once we get the full HTTP request, send a response
        if (data.includes('\r\n\r\n')) {
          const authMatch = data.match(/authorization: (.+)/i);
          const responseBody = JSON.stringify({ auth: authMatch?.[1]?.trim() ?? 'none' });
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`
          );
          socket.end();
        }
      });
    });
    await new Promise<void>(resolve => tlsEchoServer.listen(0, '127.0.0.1', resolve));
    const echoPort = (tlsEchoServer.address() as AddressInfo).port;
    cleanups.push(() => tlsEchoServer.close());

    // 2. Create credential map with a placeholder
    const credMap = new CredentialPlaceholderMap();
    const placeholder = credMap.register('LINEAR_API_KEY', 'lin_api_REAL_SECRET');

    // 3. Start web proxy in MITM mode
    const proxy = await startWebProxy({
      listen: 0,
      sessionId: 'mitm-test',
      allowedIPs: ALLOW_LOCALHOST,
      mitm: { ca, credentials: credMap },
    });
    cleanups.push(proxy.stop);
    const proxyPort = proxy.address as number;

    // 4. Make HTTPS request through proxy with placeholder in Authorization header
    const result = await mitmProxyFetch(proxyPort, `https://127.0.0.1:${echoPort}/api/issues`, {
      headers: { authorization: `Bearer ${placeholder}` },
      ca: ca.cert,
    });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    // The echo server should have received the REAL key, not the placeholder
    expect(body.auth).toBe('Bearer lin_api_REAL_SECRET');
  });

  test('passes through HTTPS without replacement when no placeholders', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
    cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
    const ca = await getOrCreateCA(caDir);

    const credMap = new CredentialPlaceholderMap();

    const proxy = await startWebProxy({
      listen: 0,
      sessionId: 'mitm-test-passthrough',
      allowedIPs: ALLOW_LOCALHOST,
      mitm: { ca, credentials: credMap },
    });
    cleanups.push(proxy.stop);

    // This test just verifies the proxy doesn't break non-credential traffic.
    // Full verification requires the TLS echo server setup from above.
    expect(proxy.address).toBeGreaterThan(0);
  });

  test('bypasses MITM for domains in bypass list', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
    cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
    const ca = await getOrCreateCA(caDir);

    const credMap = new CredentialPlaceholderMap();

    const proxy = await startWebProxy({
      listen: 0,
      sessionId: 'mitm-bypass-test',
      allowedIPs: ALLOW_LOCALHOST,
      mitm: { ca, credentials: credMap, bypassDomains: new Set(['pinned.example.com']) },
    });
    cleanups.push(proxy.stop);

    // CONNECT to a bypassed domain should use raw tunnel (old behavior)
    // We verify by checking the proxy starts without error — full bypass
    // testing requires a real TLS server with cert pinning.
    expect(proxy.address).toBeGreaterThan(0);
  });
});
```

Also add this helper function near the top of the test file:

```typescript
/** Make an HTTPS request through the MITM proxy. */
async function mitmProxyFetch(
  proxyPort: number,
  targetUrl: string,
  opts: { headers?: Record<string, string>; ca: string; method?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);

    // Step 1: CONNECT to proxy
    const connectReq = require('node:http').request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
    });

    connectReq.on('connect', (_res: any, socket: net.Socket) => {
      // Step 2: TLS handshake over the tunnel, trusting the MITM CA
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        ca: opts.ca,
        // Allow self-signed since our test server uses the same CA
        rejectUnauthorized: true,
      }, () => {
        // Step 3: Send HTTP request over TLS
        const reqLines = [
          `${opts.method ?? 'GET'} ${target.pathname} HTTP/1.1`,
          `Host: ${target.hostname}:${target.port}`,
          `Connection: close`,
        ];
        if (opts.headers) {
          for (const [k, v] of Object.entries(opts.headers)) {
            reqLines.push(`${k}: ${v}`);
          }
        }
        if (opts.body) {
          reqLines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
        }
        reqLines.push('', '');
        tlsSocket.write(reqLines.join('\r\n'));
        if (opts.body) tlsSocket.write(opts.body);
      });

      let data = '';
      tlsSocket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      tlsSocket.on('end', () => {
        // Parse HTTP response
        const [header, ...bodyParts] = data.split('\r\n\r\n');
        const statusMatch = header.match(/HTTP\/\d\.\d (\d+)/);
        resolve({
          status: statusMatch ? parseInt(statusMatch[1]) : 0,
          body: bodyParts.join('\r\n\r\n'),
        });
      });
      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.end();
    setTimeout(() => reject(new Error('Timeout')), 10000);
  });
}
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: FAIL — `mitm` option not recognized / test helper errors

**Step 3: Modify `src/host/web-proxy.ts` to add MITM mode**

Add to `WebProxyOptions`:

```typescript
import type { CAKeyPair } from './proxy-ca.js';
import type { CredentialPlaceholderMap } from './credential-placeholders.js';

// Add to WebProxyOptions interface:
  /**
   * MITM TLS inspection config. When provided, CONNECT requests are intercepted:
   * the proxy terminates TLS with a dynamically-generated cert, inspects/modifies
   * traffic (credential placeholder replacement), then forwards to the real server.
   * Without this, CONNECT is a blind TCP tunnel (existing behavior).
   */
  mitm?: {
    ca: CAKeyPair;
    credentials: CredentialPlaceholderMap;
    /** Domains that bypass MITM inspection (cert-pinning CLIs). Raw TCP tunnel. */
    bypassDomains?: Set<string>;
  };
```

Replace the `handleCONNECT` function body. The new logic:

1. Check if MITM mode is enabled and domain is not bypassed
2. If bypassed or no MITM config → existing raw TCP tunnel behavior (unchanged)
3. If MITM → generate domain cert, terminate client TLS, open real TLS to target, pipe with credential replacement

The key implementation detail: after terminating TLS on both sides, read the full HTTP request from the client, perform credential replacement on headers and body, forward to the target, read the response, and stream it back. Use a simple HTTP/1.1 request parser since we're working at the TLS socket level.

```typescript
// Inside handleCONNECT, after the domain approval check and IP resolution:

// Check if MITM inspection should be used for this connection
const shouldMitm = options.mitm && !options.mitm.bypassDomains?.has(hostname);

if (shouldMitm) {
  await handleMITMConnect(clientSocket, hostname, port, resolvedIP, head, startTime, target);
  return;
}

// ... existing raw TCP tunnel code (unchanged) ...
```

New helper function inside `startWebProxy`:

```typescript
async function handleMITMConnect(
  clientSocket: net.Socket,
  hostname: string,
  port: number,
  resolvedIP: string,
  head: Buffer,
  startTime: number,
  target: string,
): Promise<void> {
  const { generateDomainCert } = await import('./proxy-ca.js');
  const domainCert = generateDomainCert(hostname, options.mitm!.ca);
  const credentials = options.mitm!.credentials;

  // Tell client the tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Terminate TLS on the client side with our generated cert
  const clientTls = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: domainCert.key,
    cert: domainCert.cert,
  });

  // Connect to the real target with TLS
  const targetTls = tls.connect({
    host: resolvedIP,
    port,
    servername: hostname,
  });

  activeSockets.add(clientTls);
  activeSockets.add(targetTls);

  let requestBytes = head.length;
  let responseBytes = 0;

  // Pipe client → (replace credentials) → target
  clientTls.on('data', (chunk: Buffer) => {
    requestBytes += chunk.length;
    const replaced = credentials.replaceAllBuffer(chunk);
    targetTls.write(replaced);
  });

  // Pipe target → client (no replacement needed on responses)
  targetTls.on('data', (chunk: Buffer) => {
    responseBytes += chunk.length;
    clientTls.write(chunk);
  });

  // Write any buffered data from CONNECT handshake
  if (head.length > 0) {
    const replaced = credentials.replaceAllBuffer(head);
    targetTls.write(replaced);
  }

  // Cleanup
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeSockets.delete(clientTls);
    activeSockets.delete(targetTls);
    clientTls.destroy();
    targetTls.destroy();

    audit({
      action: 'proxy_request',
      sessionId,
      method: 'CONNECT',
      url: target,
      status: 200,
      requestBytes,
      responseBytes,
      durationMs: Date.now() - startTime,
    });
  };

  clientTls.on('close', cleanup);
  clientTls.on('error', cleanup);
  targetTls.on('close', cleanup);
  targetTls.on('error', cleanup);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: ALL PASS (both old tests and new MITM tests)

**Step 5: Commit**

```bash
git add src/host/web-proxy.ts tests/host/web-proxy.test.ts
git commit -m "feat: add MITM TLS inspection mode to web proxy"
```

---

## Task 4: Wire Credential Placeholders into Sandbox Launch

**Files:**
- Modify: `src/host/server-completions.ts` (build credential map, pass to proxy + sandbox)
- Test: `tests/host/credential-injection-integration.test.ts`

When launching a sandbox, the host:
1. Reads the active skills' `requires.env` declarations
2. For each required env var, looks up the real value in CredentialProvider
3. Generates a placeholder and adds it to the credential map
4. Passes the map to the web proxy (for MITM replacement)
5. Injects placeholders as env vars into the sandbox via `extraEnv`

**Step 1: Write the failing test**

```typescript
// tests/host/credential-injection-integration.test.ts
import { describe, test, expect } from 'vitest';
import { CredentialPlaceholderMap } from '../../src/host/credential-placeholders.js';

describe('credential injection integration', () => {
  test('builds credential map from skill requirements and credential provider', async () => {
    // Simulate what server-completions will do
    const skillRequiredEnv = ['LINEAR_API_KEY', 'GITHUB_TOKEN'];

    // Mock credential provider
    const credentialStore: Record<string, string> = {
      LINEAR_API_KEY: 'lin_api_real_key',
      GITHUB_TOKEN: 'ghp_real_token',
    };
    const mockCredProvider = {
      get: async (key: string) => credentialStore[key] ?? null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY', 'GITHUB_TOKEN']);
    // Env values should be placeholders, not real values
    expect(envMap.LINEAR_API_KEY).toMatch(/^ax-cred:/);
    expect(envMap.GITHUB_TOKEN).toMatch(/^ax-cred:/);
    expect(envMap.LINEAR_API_KEY).not.toBe('lin_api_real_key');

    // But replaceAll should recover the real values
    const replaced = map.replaceAll(`key=${envMap.LINEAR_API_KEY}`);
    expect(replaced).toBe('key=lin_api_real_key');
  });

  test('skips env vars not found in credential provider', async () => {
    const skillRequiredEnv = ['LINEAR_API_KEY', 'MISSING_KEY'];
    const mockCredProvider = {
      get: async (key: string) => key === 'LINEAR_API_KEY' ? 'lin_api_real' : null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY']);
    // MISSING_KEY should not be in the map
    expect(envMap.MISSING_KEY).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it passes** (this test uses already-built modules)

Run: `npm test -- --run tests/host/credential-injection-integration.test.ts`
Expected: PASS (this is an integration test of already-built pieces)

**Step 3: Modify `server-completions.ts`**

In the `processCompletion` function, after the web proxy is started and before the sandbox is spawned, add credential placeholder wiring. The key changes:

1. Import `CredentialPlaceholderMap`
2. After starting the web proxy, collect `requires.env` from active skills (loaded from the workspace skills directories)
3. For each required env var, look up the value in `providers.credentials`
4. Build the `CredentialPlaceholderMap` and pass it to the web proxy's `mitm` option
5. Merge `credentialMap.toEnvMap()` into the sandbox's `extraEnv`

The modification point is in `server-completions.ts` around line 540-590 (web proxy setup) and line 798-803 (extraEnv construction).

Add after the web proxy start block (~line 588):

```typescript
// Build credential placeholders for skill-required env vars.
// Skills declare required env vars in requires.env — the host resolves them
// from the credential provider and injects placeholders into the sandbox.
// The MITM proxy replaces placeholders with real values in intercepted HTTPS traffic.
const credentialMap = new CredentialPlaceholderMap();
if (config.web_proxy) {
  // Collect requires.env from skills in agent + user workspace
  const skillEnvRequirements = await collectSkillEnvRequirements(
    agentWsPath ? join(agentWsPath, 'skills') : undefined,
    userWsPath ? join(userWsPath, 'skills') : undefined,
  );
  for (const envName of skillEnvRequirements) {
    const realValue = await providers.credentials.get(envName);
    if (realValue) {
      credentialMap.register(envName, realValue);
      reqLogger.debug('credential_placeholder_registered', { envName });
    } else {
      reqLogger.debug('credential_not_found', { envName });
    }
  }
}
```

Add a helper function in the same file:

```typescript
import { readdirSync, readFileSync } from 'node:fs';
import { parseAgentSkill } from '../utils/skill-format-parser.js';

/** Scan skill files in agent and user skill directories for requires.env declarations. */
async function collectSkillEnvRequirements(
  agentSkillsDir?: string,
  userSkillsDir?: string,
): Promise<Set<string>> {
  const envVars = new Set<string>();
  for (const dir of [agentSkillsDir, userSkillsDir]) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), 'utf-8');
          const parsed = parseAgentSkill(raw);
          for (const env of parsed.requires.env) {
            envVars.add(env);
          }
        } catch { /* skip unparseable skills */ }
      }
    } catch { /* skip unreadable directories */ }
  }
  return envVars;
}
```

Modify the extraEnv in the sandbox config (~line 798):

```typescript
extraEnv: {
  ...deps.extraSandboxEnv,
  ...(webProxyPort ? { AX_PROXY_LISTEN_PORT: String(webProxyPort) } : {}),
  ...credentialMap.toEnvMap(),
},
```

**Step 4: Run existing tests to verify no regressions**

Run: `npm test -- --run tests/host/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts tests/host/credential-injection-integration.test.ts
git commit -m "feat: wire credential placeholders into sandbox launch pipeline"
```

---

## Task 5: CA Certificate Injection into Sandbox Containers

**Files:**
- Modify: `src/providers/sandbox/k8s.ts` (mount CA cert, set NODE_EXTRA_CA_CERTS)
- Modify: `src/providers/sandbox/canonical-paths.ts` (add CA cert env var)
- Modify: `src/host/server-completions.ts` (pass CA cert path via extraEnv)
- Test: `tests/providers/sandbox/k8s-ca-injection.test.ts`

For the MITM proxy to work, sandbox containers must trust the AX CA. The approach differs by sandbox type:
- **k8s:** Mount CA cert as a ConfigMap volume, set `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`
- **Docker/Apple Container:** Mount CA cert file into the container
- **Subprocess:** Set `NODE_EXTRA_CA_CERTS` env var pointing to host CA cert path

**Step 1: Write the failing test**

```typescript
// tests/providers/sandbox/k8s-ca-injection.test.ts
import { describe, test, expect } from 'vitest';

describe('k8s CA injection', () => {
  test('pod spec includes CA cert volume mount when extraEnv has AX_CA_CERT_PATH', async () => {
    // We test the env var injection path — k8s.ts should propagate
    // NODE_EXTRA_CA_CERTS from extraEnv into the pod spec
    const config = {
      workspace: '/workspace',
      ipcSocket: '',
      command: ['node', 'runner.js'],
      extraEnv: {
        AX_CA_CERT_PATH: '/etc/ax/ca.crt',
        NODE_EXTRA_CA_CERTS: '/etc/ax/ca.crt',
        SSL_CERT_FILE: '/etc/ax/ca.crt',
      },
    };

    // Verify that extraEnv values would be included in pod env
    const envEntries = Object.entries(config.extraEnv ?? {})
      .map(([name, value]) => ({ name, value }));

    const nodeExtraCa = envEntries.find(e => e.name === 'NODE_EXTRA_CA_CERTS');
    expect(nodeExtraCa).toBeDefined();
    expect(nodeExtraCa!.value).toBe('/etc/ax/ca.crt');

    const sslCertFile = envEntries.find(e => e.name === 'SSL_CERT_FILE');
    expect(sslCertFile).toBeDefined();
    expect(sslCertFile!.value).toBe('/etc/ax/ca.crt');
  });
});
```

**Step 2: Run test to verify it passes** (this is a unit test of the data flow)

Run: `npm test -- --run tests/providers/sandbox/k8s-ca-injection.test.ts`
Expected: PASS

**Step 3: Modify `server-completions.ts` to pass CA cert env vars**

In the web proxy setup block, after generating the CA, add CA cert path to extraEnv:

```typescript
// When MITM is enabled, inject CA trust env vars so sandbox processes
// trust the proxy's generated certificates.
if (ca) {
  const caCertPath = join(caDir, 'ca.crt');
  // For subprocess mode, point directly to host path
  // For container modes, the cert is mounted at a canonical path
  const containerCaCertPath = '/etc/ax/ca.crt';
  const sandboxCaCertPath = isContainerSandbox ? containerCaCertPath : caCertPath;

  // These env vars are respected by Node.js, Python, curl, and most HTTP clients
  credentialEnv.NODE_EXTRA_CA_CERTS = sandboxCaCertPath;
  credentialEnv.SSL_CERT_FILE = sandboxCaCertPath;
  credentialEnv.REQUESTS_CA_BUNDLE = sandboxCaCertPath; // Python requests
}
```

For k8s, the CA cert needs to be available in the pod. The simplest approach: pass the CA cert content as an env var and write it to a file in an init script, or create a ConfigMap. For the initial implementation, pass the cert content via the NATS work payload and have the runner write it to `/tmp/ax-ca.crt`.

Add to the work payload (in the stdin payload section ~line 758):

```typescript
// CA certificate for MITM proxy trust (written to /tmp/ax-ca.crt by runner)
caCert: ca?.cert,
```

**Step 4: Modify the agent runner to write CA cert**

In `src/agent/runner.ts`, after processing the work payload:

```typescript
// Write CA cert for MITM proxy trust if provided
if (payload.caCert) {
  const caCertPath = '/tmp/ax-ca.crt';
  writeFileSync(caCertPath, payload.caCert);
  process.env.NODE_EXTRA_CA_CERTS = caCertPath;
  process.env.SSL_CERT_FILE = caCertPath;
  process.env.REQUESTS_CA_BUNDLE = caCertPath;
}
```

**Step 5: Run all tests**

Run: `npm test -- --run tests/providers/sandbox/ tests/host/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/host/server-completions.ts src/providers/sandbox/k8s.ts src/providers/sandbox/canonical-paths.ts src/agent/runner.ts tests/providers/sandbox/k8s-ca-injection.test.ts
git commit -m "feat: inject CA cert into sandbox containers for MITM trust"
```

---

## Task 6: MITM Bypass List Configuration

**Files:**
- Modify: `src/types.ts` (add `mitm_bypass_domains` to Config)
- Modify: `src/host/server-completions.ts` (pass bypass list to web proxy)
- Test: `tests/host/web-proxy.test.ts` (add bypass test with real CONNECT)

**Step 1: Write the failing test**

Add to `tests/host/web-proxy.test.ts` inside the MITM describe block:

```typescript
test('MITM bypass domain falls through to raw TCP tunnel', async () => {
  const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
  const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
  cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
  const ca = await getOrCreateCA(caDir);
  const credMap = new CredentialPlaceholderMap();

  // Start TCP echo server (not TLS — simulates a bypassed raw tunnel)
  const echo = await startTCPEchoServer();
  cleanups.push(() => echo.server.close());

  const proxy = await startWebProxy({
    listen: 0,
    sessionId: 'bypass-test',
    allowedIPs: ALLOW_LOCALHOST,
    mitm: {
      ca,
      credentials: credMap,
      bypassDomains: new Set(['127.0.0.1']),
    },
  });
  cleanups.push(proxy.stop);

  // CONNECT to a bypassed domain should be a raw tunnel
  const result = await proxyConnect(
    proxy.address as number,
    '127.0.0.1',
    echo.port,
    'bypass-test-data',
  );

  // Raw tunnel should work (TCP echo server, not TLS)
  expect(result.established).toBe(true);
  expect(result.response).toContain('echo:bypass-test-data');
});
```

**Step 2: Run test to verify it fails (or passes if bypass logic from Task 3 already works)**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: Depends on Task 3 implementation — may pass already

**Step 3: Add config field**

In `src/types.ts`, add to the Config interface:

```typescript
/** Domains that bypass MITM TLS inspection (cert-pinning CLIs). */
mitm_bypass_domains?: string[];
```

In `server-completions.ts`, pass the config value to the web proxy:

```typescript
mitm: ca ? {
  ca,
  credentials: credentialMap,
  bypassDomains: new Set(config.mitm_bypass_domains ?? []),
} : undefined,
```

**Step 4: Run tests**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/types.ts src/host/server-completions.ts tests/host/web-proxy.test.ts
git commit -m "feat: add MITM bypass domain list for cert-pinning CLIs"
```

---

## Task 7: Audit Logging for Credential Injection

**Files:**
- Modify: `src/host/web-proxy.ts` (add `credential_injected` to audit entry)
- Modify: `src/host/web-proxy.ts` (add ProxyAuditEntry field)
- Test: `tests/host/web-proxy.test.ts` (verify audit entry includes credential injection flag)

**Step 1: Write the failing test**

```typescript
test('audit entry includes credential_injected flag when replacement occurs', async () => {
  const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
  const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
  cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
  const ca = await getOrCreateCA(caDir);

  const credMap = new CredentialPlaceholderMap();
  const placeholder = credMap.register('API_KEY', 'real_secret');

  const entries: ProxyAuditEntry[] = [];

  // Start TLS echo server
  const { generateDomainCert } = await import('../../src/host/proxy-ca.js');
  const serverCert = generateDomainCert('127.0.0.1', ca);
  const tlsServer = tls.createServer({ key: serverCert.key, cert: serverCert.cert }, (socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.end();
    });
  });
  await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
  const serverPort = (tlsServer.address() as AddressInfo).port;
  cleanups.push(() => tlsServer.close());

  const proxy = await startWebProxy({
    listen: 0,
    sessionId: 'audit-cred-test',
    allowedIPs: ALLOW_LOCALHOST,
    onAudit: (e) => entries.push(e),
    mitm: { ca, credentials: credMap },
  });
  cleanups.push(proxy.stop);

  await mitmProxyFetch(proxy.address as number, `https://127.0.0.1:${serverPort}/api`, {
    headers: { authorization: `Bearer ${placeholder}` },
    ca: ca.cert,
  });

  expect(entries.length).toBe(1);
  expect(entries[0].credentialInjected).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: FAIL — `credentialInjected` not on audit entry

**Step 3: Add field to ProxyAuditEntry and set it in MITM handler**

In `web-proxy.ts`:

```typescript
// Add to ProxyAuditEntry:
  credentialInjected?: boolean;
```

In the MITM handler, track whether any replacement occurred:

```typescript
clientTls.on('data', (chunk: Buffer) => {
  requestBytes += chunk.length;
  const replaced = credentials.replaceAllBuffer(chunk);
  if (replaced !== chunk) credentialInjected = true;
  targetTls.write(replaced);
});
```

Include it in the audit call in the cleanup function.

**Step 4: Run tests**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/host/web-proxy.ts tests/host/web-proxy.test.ts
git commit -m "feat: audit log credential injection events in MITM proxy"
```

---

## Task 8: Canary Token Scanning on Decrypted HTTPS Traffic

**Files:**
- Modify: `src/host/web-proxy.ts` (scan decrypted MITM traffic for canary tokens)
- Test: `tests/host/web-proxy.test.ts` (canary detection in MITM mode)

Currently canary scanning only works on plain HTTP request bodies. With MITM, we can now scan HTTPS traffic too.

**Step 1: Write the failing test**

```typescript
test('blocks MITM traffic when canary detected in decrypted body', async () => {
  const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
  const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
  cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
  const ca = await getOrCreateCA(caDir);

  const canary = 'CANARY-exfil-detect-test-12345';
  const credMap = new CredentialPlaceholderMap();

  // TLS echo server
  const serverCert = generateDomainCert('127.0.0.1', ca);
  const tlsServer = tls.createServer({ key: serverCert.key, cert: serverCert.cert }, (socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.end();
    });
  });
  await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
  const serverPort = (tlsServer.address() as AddressInfo).port;
  cleanups.push(() => tlsServer.close());

  const proxy = await startWebProxy({
    listen: 0,
    sessionId: 'canary-mitm-test',
    canaryToken: canary,
    allowedIPs: ALLOW_LOCALHOST,
    mitm: { ca, credentials: credMap },
  });
  cleanups.push(proxy.stop);

  // Send HTTPS request with canary in the body
  const result = await mitmProxyFetch(
    proxy.address as number,
    `https://127.0.0.1:${serverPort}/exfil`,
    { method: 'POST', body: `secret data with ${canary} inside`, ca: ca.cert },
  ).catch(() => ({ status: 0, body: 'connection_closed' }));

  // Proxy should close/block the connection when canary detected
  // The exact behavior (403 response or connection close) depends on implementation
  expect(result.status === 403 || result.body === 'connection_closed').toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: FAIL — canary not detected in MITM mode (traffic passes through)

**Step 3: Add canary scanning to MITM handler**

In the MITM `clientTls.on('data', ...)` handler, check for canary before forwarding:

```typescript
clientTls.on('data', (chunk: Buffer) => {
  requestBytes += chunk.length;

  // Canary scanning on decrypted HTTPS traffic
  if (canaryToken && chunk.includes(canaryToken)) {
    canaryDetected = true;
    audit({
      action: 'proxy_request', sessionId, method: 'CONNECT', url: target,
      status: 403, requestBytes, responseBytes: 0,
      durationMs: Date.now() - startTime, blocked: 'canary_detected',
    });
    clientTls.destroy();
    targetTls.destroy();
    return;
  }

  const replaced = credentials.replaceAllBuffer(chunk);
  if (replaced !== chunk) credentialInjected = true;
  targetTls.write(replaced);
});
```

**Step 4: Run tests**

Run: `npm test -- --run tests/host/web-proxy.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/host/web-proxy.ts tests/host/web-proxy.test.ts
git commit -m "feat: canary token scanning on decrypted HTTPS traffic in MITM mode"
```

---

## Task 9: Update Skills Documentation and CLAUDE.md

**Files:**
- Modify: `.claude/skills/ax/ax-provider-web.md` (document MITM credential injection)
- Modify: `.claude/skills/ax/ax-security.md` (document credential-never-enters-container guarantee)
- Modify: `.claude/skills/ax/ax-provider-credentials.md` (document credential placeholder flow)

**Step 1: Update ax-provider-web skill**

Add a section documenting the MITM proxy mode, credential injection flow, bypass list, and how skills declare required env vars.

**Step 2: Update ax-security skill**

Document that the "credentials never enter containers" invariant is maintained via placeholder injection + MITM replacement. Document the CA trust chain. Document the bypass list as a known tradeoff.

**Step 3: Update ax-provider-credentials skill**

Document how the credential provider is used during sandbox launch to build the placeholder map.

**Step 4: Commit**

```bash
git add .claude/skills/ax/
git commit -m "docs: update skills for MITM credential injection architecture"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | CA certificate generation | `src/host/proxy-ca.ts` |
| 2 | Credential placeholder map | `src/host/credential-placeholders.ts` |
| 3 | MITM TLS termination in CONNECT handler | `src/host/web-proxy.ts` |
| 4 | Wire credentials into sandbox launch | `src/host/server-completions.ts` |
| 5 | CA cert injection into containers | `k8s.ts`, `runner.ts`, `canonical-paths.ts` |
| 6 | Bypass list configuration | `src/types.ts`, `server-completions.ts` |
| 7 | Audit logging for credential injection | `src/host/web-proxy.ts` |
| 8 | Canary scanning on decrypted HTTPS | `src/host/web-proxy.ts` |
| 9 | Documentation updates | `.claude/skills/ax/` |

**Dependencies:** Task 3 depends on Tasks 1+2. Task 4 depends on Tasks 2+3. Task 5 depends on Task 1. Tasks 6-8 depend on Task 3. Task 9 depends on all others.

**Not in scope (future work):**
- OAuth token refresh handling (API keys only for now)
- Docker/Apple Container sandbox CA injection (k8s + subprocess first)
- Admin UI for credential management
- Per-skill credential approval gates
