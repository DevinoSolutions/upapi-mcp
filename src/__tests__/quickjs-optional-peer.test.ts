import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUpapiMcpServer } from '../mastra.js';
import { EXECUTE_TYPESCRIPT_TOOL_NAME } from '../code-mode.js';
import type { Caller } from '../tools.js';

/**
 * `@mastra/quickjs` and `quickjs-emscripten` (the WASM module the CPU-budgeted
 * transport hands it) are OPTIONAL peers of `@upapi/mcp`: someone importing
 * `@upapi/mcp/mastra` only for `createUpapiTools` or the `full` surface may not
 * have them installed. So neither may load until an `execute_typescript` call
 * actually needs the sandbox.
 *
 * The mocks pass the real modules through unchanged; they only record WHEN each
 * was first imported.
 */

const loaded = vi.hoisted(() => ({ quickjs: false, emscripten: false }));

vi.mock('@mastra/quickjs', async (importOriginal) => {
  loaded.quickjs = true;
  return importOriginal();
});

vi.mock('quickjs-emscripten', async (importOriginal) => {
  loaded.emscripten = true;
  return importOriginal();
});

const caller: Caller = vi.fn(async () => ({ ok: true }));

type CallToolResult = { isError?: boolean; content: Array<{ text: string }> };

describe('@mastra/quickjs is loaded lazily', () => {
  it('importing @upapi/mcp/mastra and building a Code Mode server does not load it', () => {
    const server = createUpapiMcpServer({ caller, surface: 'codemode' });
    expect(server).toBeDefined();
    expect(loaded.quickjs).toBe(false);
    expect(loaded.emscripten).toBe(false);
  });

  it('the first execute_typescript call loads it and runs the program', async () => {
    const server = createUpapiMcpServer({ caller, surface: 'codemode' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([
      server.getServer().connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const result = (await client.callTool({
        name: EXECUTE_TYPESCRIPT_TOOL_NAME,
        arguments: { code: 'return 20 + 22;' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('42');
      expect(loaded.quickjs).toBe(true);
      expect(loaded.emscripten).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
