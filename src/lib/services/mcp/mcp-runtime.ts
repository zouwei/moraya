/**
 * MCP Runtime - Lightweight MCP server for AI-generated dynamic services.
 *
 * This string constant contains a self-contained Node.js script that implements
 * the MCP protocol over stdio. It reads tool definitions from `definition.json`
 * and handler functions from `handlers.js` in the service directory.
 *
 * Usage: node mcp-runtime.js --dir <service-directory>
 *
 * Requirements: Node.js >= 18 (for built-in fetch)
 */
export const MCP_RUNTIME_JS = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse --dir argument
const dirIdx = process.argv.indexOf('--dir');
if (dirIdx === -1 || !process.argv[dirIdx + 1]) {
  process.stderr.write('Usage: node mcp-runtime.js --dir <service-directory>\\n');
  process.exit(1);
}
const dir = process.argv[dirIdx + 1];

// Load service definition and handlers
let definition, handlers;
try {
  definition = JSON.parse(fs.readFileSync(path.join(dir, 'definition.json'), 'utf8'));
  handlers = require(path.join(dir, 'handlers.js'));
} catch (err) {
  process.stderr.write('Failed to load service files: ' + err.message + '\\n');
  process.exit(1);
}

// JSON-RPC response helper
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

// Read JSON-RPC messages from stdin
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Skip non-JSON lines
  }

  // Notifications have no id — no response needed
  if (!('id' in msg)) return;

  try {
    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: definition.name || 'dynamic-mcp-service',
              version: '1.0.0',
            },
          },
        });
        break;

      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: definition.tools || [] },
        });
        break;

      case 'tools/call': {
        const { name, arguments: args } = msg.params;
        const handler = handlers[name];
        if (!handler) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: 'Unknown tool: ' + name }],
              isError: true,
            },
          });
          break;
        }

        try {
          const result = await handler(args || {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text }],
            },
          });
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: 'Error: ' + err.message }],
              isError: true,
            },
          });
        }
        break;
      }

      default:
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found: ' + msg.method },
        });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: err.message },
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
