// Minimal MCP stdio client for the shell scripts: spawns dist/index.js and speaks JSON-RPC to it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(here, '..', '..', 'packages', 'mcp-server', 'dist', 'index.js');

export async function createClient({ timeoutMs = Number(process.env.MCP_CALL_TIMEOUT || 120000) } = {}) {
  const child = spawn(process.execPath, [wrapper], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      FOUNDRY_HOST: process.env.FOUNDRY_HOST || 'localhost',
      FOUNDRY_PORT: process.env.FOUNDRY_PORT || '31415',
      FOUNDRY_CONNECTION_TYPE: process.env.FOUNDRY_CONNECTION_TYPE || 'websocket',
      LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    },
  });

  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-scripts', version: '0.1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  return {
    async listTools() {
      const res = await rpc('tools/list', {});
      return res.result?.tools ?? [];
    },
    /** Call a tool; returns parsed JSON when the text is JSON, else the raw text. Throws on isError. */
    async call(name, args = {}) {
      const res = await rpc('tools/call', { name, arguments: args });
      if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
      const text = (res.result?.content ?? []).map(c => (c.type === 'text' ? c.text : '')).join('\n');
      if (res.result?.isError) throw new Error(`${name}: ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
