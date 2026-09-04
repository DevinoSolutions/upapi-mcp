import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OPERATIONS } from '@upapi/sdk';
import { createUpapiStdioServer, resolveStdioToolMode } from '../stdio.js';
import { isDirectoryListedOperation, type Caller } from '../tools.js';
import { CALL_OP_TOOL_NAME } from '../facade.js';

/**
 * The stdio surface, driven through a REAL MCP client over an in-memory pair of
 * transports — so what is asserted is what goes on the wire, not what the
 * builder function returned.
 *
 * This is the transport a Claude Desktop Extension starts, and the reason it no
 * longer runs on Mastra: `createTool` has no annotations field, so every tool
 * this server advertised used to arrive with its behaviour unstated.
 */

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

async function connect(mode: 'compact' | 'directory' | 'full') {
  const server = createUpapiStdioServer({ caller: noopCaller, mode });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('resolveStdioToolMode', () => {
  it('reads UPAPI_TOOL_MODE and defaults to full', () => {
    expect(resolveStdioToolMode({})).toBe('full');
    expect(resolveStdioToolMode({ UPAPI_TOOL_MODE: 'directory' })).toBe('directory');
    expect(resolveStdioToolMode({ UPAPI_TOOL_MODE: 'compact' })).toBe('compact');
    // A typo in a client config must not leave a server that will not boot.
    expect(resolveStdioToolMode({ UPAPI_TOOL_MODE: 'Directory ' })).toBe('full');
  });
});

describe('the stdio server puts annotations on the wire', () => {
  it('states all four hints on every tool it advertises', async () => {
    const { client, close } = await connect('full');
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(OPERATIONS.length);
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toMatchObject({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        });
        expect(tool.title, tool.name).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it('serves the whole catalog in full mode and the withheld-free flagship set in directory mode', async () => {
    const { client, close } = await connect('directory');
    try {
      const { tools } = await client.listTools();
      const withheld = new Set(
        OPERATIONS.filter((op) => !isDirectoryListedOperation(op)).map((op) => op.operationId),
      );
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.length).toBeLessThan(OPERATIONS.length);
      expect(tools.map((tool) => tool.name).filter((name) => withheld.has(name))).toEqual([]);
    } finally {
      await close();
    }
  });

  it('runs an operation and returns its result', async () => {
    const { client, close } = await connect('full');
    try {
      const first = OPERATIONS[0];
      expect(first).toBeDefined();
      const result = (await client.callTool({
        name: first!.operationId,
        arguments: {},
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('"ok": true');
    } finally {
      await close();
    }
  });

  it('reports an unknown tool as a failed call, not a protocol error', async () => {
    const { client, close } = await connect('full');
    try {
      const result = (await client.callTool({ name: 'no_such_tool', arguments: {} })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('NOT_FOUND');
    } finally {
      await close();
    }
  });

  it('keeps call_op dispatchable even where it is not listed', async () => {
    const { client, close } = await connect('directory');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain(CALL_OP_TOOL_NAME);
      const first = OPERATIONS.find(isDirectoryListedOperation);
      expect(first).toBeDefined();
      const result = (await client.callTool({
        name: CALL_OP_TOOL_NAME,
        arguments: { slug: first!.slug, input: {} },
      })) as { isError?: boolean };
      expect(result.isError).not.toBe(true);
    } finally {
      await close();
    }
  });
});
