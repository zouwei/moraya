import { describe, it, expect } from 'vitest';
import {
  secretsOf,
  hasPlaintextSecrets,
  withoutSecretValues,
  withSecretValues,
} from './mcp-secrets';
import type { MCPServerConfig } from './types';

const stdio = (env?: Record<string, string>): MCPServerConfig =>
  ({ id: 's1', name: 'S', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['-y', 'x'], ...(env ? { env } : {}) } }) as MCPServerConfig;

const http = (headers?: Record<string, string>): MCPServerConfig =>
  ({ id: 's2', name: 'H', enabled: true, transport: { type: 'http', url: 'https://x.io', ...(headers ? { headers } : {}) } }) as MCPServerConfig;

describe('secretsOf', () => {
  it('finds stdio env', () => {
    expect(secretsOf(stdio({ A: '1' }))).toEqual({ A: '1' });
  });
  it('finds http/sse headers — they carry bearer tokens too', () => {
    expect(secretsOf(http({ Authorization: 'Bearer t' }))).toEqual({ Authorization: 'Bearer t' });
  });
  it('is undefined when the transport has neither', () => {
    expect(secretsOf(stdio())).toBeUndefined();
  });
});

describe('hasPlaintextSecrets', () => {
  it('is true when any value is non-empty', () => {
    expect(hasPlaintextSecrets(stdio({ A: '', B: 'secret' }))).toBe(true);
  });
  it('is false once values are blanked (post-migration state)', () => {
    expect(hasPlaintextSecrets(stdio({ A: '', B: '' }))).toBe(false);
  });
  it('is false with no secret map at all', () => {
    expect(hasPlaintextSecrets(stdio())).toBe(false);
  });
});

describe('withoutSecretValues', () => {
  it('blanks values but keeps key names, so the UI can still list them', () => {
    const out = withoutSecretValues(stdio({ WECHAT_APP_ID: 'wx1', WECHAT_APP_SECRET: 'shh' }));
    const env = (out.transport as { env: Record<string, string> }).env;
    expect(Object.keys(env)).toEqual(['WECHAT_APP_ID', 'WECHAT_APP_SECRET']);
    expect(Object.values(env)).toEqual(['', '']);
  });

  it('never leaks a value into what gets written to disk', () => {
    const out = withoutSecretValues(stdio({ K: 'super-secret-value' }));
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
  });

  it('blanks headers for http transports', () => {
    const out = withoutSecretValues(http({ Authorization: 'Bearer t' }));
    expect((out.transport as { headers: Record<string, string> }).headers).toEqual({ Authorization: '' });
  });

  it('leaves the original untouched (no in-place mutation of live state)', () => {
    const src = stdio({ K: 'v' });
    withoutSecretValues(src);
    expect((src.transport as { env: Record<string, string> }).env).toEqual({ K: 'v' });
  });

  it('passes through a transport with no secret map', () => {
    const src = stdio();
    expect(withoutSecretValues(src)).toEqual(src);
  });
});

describe('withSecretValues', () => {
  it('restores values onto the blanked keys', () => {
    const onDisk = withoutSecretValues(stdio({ A: 'x', B: 'y' }));
    const back = withSecretValues(onDisk, { A: 'x', B: 'y' });
    expect((back.transport as { env: Record<string, string> }).env).toEqual({ A: 'x', B: 'y' });
  });

  it('keeps keys the keychain does not know about', () => {
    const onDisk = withoutSecretValues(stdio({ A: 'x', NEW: 'z' }));
    const back = withSecretValues(onDisk, { A: 'x' });
    const env = (back.transport as { env: Record<string, string> }).env;
    expect(env).toEqual({ A: 'x', NEW: '' });
  });

  it('restores headers for http transports', () => {
    const onDisk = withoutSecretValues(http({ Authorization: 'Bearer t' }));
    const back = withSecretValues(onDisk, { Authorization: 'Bearer t' });
    expect((back.transport as { headers: Record<string, string> }).headers).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('round trip', () => {
  it('disk copy holds no secrets, and hydration restores the original', () => {
    const original = stdio({ WECHAT_APP_ID: 'wx6ab', WECHAT_APP_SECRET: 'topsecret' });
    const secrets = secretsOf(original)!;
    const onDisk = withoutSecretValues(original);
    expect(JSON.stringify(onDisk)).not.toContain('topsecret');
    expect(hasPlaintextSecrets(onDisk)).toBe(false);
    expect(withSecretValues(onDisk, secrets)).toEqual(original);
  });
});

describe('blank-only-when-saved contract', () => {
  // persistMCPServers must blank a server on disk ONLY when its keychain write
  // succeeded. This encodes the rule the storage layer relies on; the manager
  // owns the keychain call itself (it needs Tauri) but must honour this.
  it('a failed save must leave the config untouched, not blanked', () => {
    const server = stdio({ SECRET: 'real-value' });
    const savedOk = false;
    const written = savedOk ? withoutSecretValues(server) : server;
    // Blanking here would destroy the only remaining copy of the credential.
    expect(hasPlaintextSecrets(written)).toBe(true);
    expect(JSON.stringify(written)).toContain('real-value');
  });

  it('a successful save blanks it', () => {
    const server = stdio({ SECRET: 'real-value' });
    const savedOk = true;
    const written = savedOk ? withoutSecretValues(server) : server;
    expect(JSON.stringify(written)).not.toContain('real-value');
  });
});
