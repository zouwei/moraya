/**
 * Pure helpers for keeping MCP server credentials out of the config file.
 *
 * A server's `env` (stdio) and `headers` (sse/http) carry real credentials —
 * API secrets, bearer tokens. They used to be written verbatim into
 * `mcp-config.json`, a plaintext file on disk, which the project's security
 * rules forbid for any credential. They now live in the OS keychain keyed by
 * server id, exactly like AI provider keys; only the KEY NAMES stay on disk so
 * the settings UI can still show which variables a server expects.
 *
 * Kept dependency-free (no Tauri imports) so the redaction rules are unit
 * tested directly — mcp-manager.ts owns the keychain I/O around them.
 */

import type { MCPServerConfig } from './types';

/** Transports carry their secrets under different names. */
type SecretBearing = { env?: Record<string, string>; headers?: Record<string, string> };

/** The secret-bearing map of a transport, if it has one. */
export function secretsOf(server: MCPServerConfig): Record<string, string> | undefined {
  const t = server.transport as SecretBearing;
  return t.env ?? t.headers;
}

/** True when the config still holds real credential values (pre-migration). */
export function hasPlaintextSecrets(server: MCPServerConfig): boolean {
  const secrets = secretsOf(server);
  return !!secrets && Object.values(secrets).some((v) => v !== '');
}

/**
 * Copy of a server with secret VALUES blanked but their keys kept — what is
 * safe to write to disk. Keys are retained so the UI can still list which
 * variables a server expects without holding their values.
 */
export function withoutSecretValues(server: MCPServerConfig): MCPServerConfig {
  const t = server.transport as SecretBearing;
  const blank = (m: Record<string, string>) =>
    Object.fromEntries(Object.keys(m).map((k) => [k, '']));
  if (t.env) {
    return { ...server, transport: { ...t, env: blank(t.env) } as MCPServerConfig['transport'] };
  }
  if (t.headers) {
    return { ...server, transport: { ...t, headers: blank(t.headers) } as MCPServerConfig['transport'] };
  }
  return server;
}

/** Merge keychain-held secret values back into a server config. */
export function withSecretValues(
  server: MCPServerConfig,
  secrets: Record<string, string>,
): MCPServerConfig {
  const t = server.transport as SecretBearing;
  if (t.env) {
    return {
      ...server,
      transport: { ...t, env: { ...t.env, ...secrets } } as MCPServerConfig['transport'],
    };
  }
  if (t.headers) {
    return {
      ...server,
      transport: { ...t, headers: { ...t.headers, ...secrets } } as MCPServerConfig['transport'],
    };
  }
  return server;
}
