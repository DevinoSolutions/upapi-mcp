import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OPERATIONS } from '@upapi/sdk';
import {
  createUpapiMcpServer,
  parseMcpToolSurface,
  resolveMcpToolSurface,
  type McpToolSurface,
} from '../mastra.js';
import {
  CODE_MODE_TIMEOUT_MS,
  EXECUTE_TYPESCRIPT_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME,
} from '../code-mode.js';
import type { Caller } from '../tools.js';

/**
 * The Mastra `MCPServer` surface, driven through a REAL MCP client over an
 * in-memory pair of transports — what is asserted here is what goes on the
 * wire, matching `stdio.test.ts`'s approach for the raw SDK server. `MCPServer`
 * builds its underlying SDK `Server` (with every handler registered) in its own
 * constructor, so connecting to `getServer()` directly needs no `startStdio` /
 * `startHTTP` call, exactly like `createUpapiStdioServer`'s `Server`.
 */

async function connect(caller: Caller, surface?: McpToolSurface) {
  const server = createUpapiMcpServer(surface === undefined ? { caller } : { caller, surface });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.getServer().connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type CallToolResult = { isError?: boolean; content: Array<{ text: string }> };

describe('resolveMcpToolSurface', () => {
  it('reads MCP_TOOL_SURFACE and defaults to codemode', () => {
    expect(resolveMcpToolSurface({})).toBe('codemode');
    expect(resolveMcpToolSurface({ MCP_TOOL_SURFACE: 'full' })).toBe('full');
    expect(resolveMcpToolSurface({ MCP_TOOL_SURFACE: 'both' })).toBe('both');
    // A typo in a client config must not leave a server that will not boot.
    expect(resolveMcpToolSurface({ MCP_TOOL_SURFACE: 'Full ' })).toBe('codemode');
  });

  it('parseMcpToolSurface narrows only the three known values', () => {
    expect(parseMcpToolSurface('codemode')).toBe('codemode');
    expect(parseMcpToolSurface('full')).toBe('full');
    expect(parseMcpToolSurface('both')).toBe('both');
    expect(parseMcpToolSurface('compact')).toBeUndefined();
    expect(parseMcpToolSurface(undefined)).toBeUndefined();
  });
});

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

describe('the default Mastra MCP surface is Code Mode', () => {
  it('advertises exactly search_tools and execute_typescript, regardless of catalog size', async () => {
    const { client, close } = await connect(noopCaller);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [EXECUTE_TYPESCRIPT_TOOL_NAME, SEARCH_TOOLS_TOOL_NAME].sort(),
      );
      // The invariant this whole surface exists for: the table does not grow
      // with the catalog. `OPERATIONS.length` is the number of tools the
      // `full` surface would have advertised instead.
      expect(tools.length).toBeLessThan(OPERATIONS.length);
    } finally {
      await close();
    }
  });

  it('carries the Code Mode contract in the server instructions', async () => {
    const { client, close } = await connect(noopCaller);
    try {
      const instructions = client.getInstructions();
      expect(instructions).toContain(SEARCH_TOOLS_TOOL_NAME);
      expect(instructions).toContain(EXECUTE_TYPESCRIPT_TOOL_NAME);
      expect(instructions).toContain('<CODE>: <message>');
    } finally {
      await close();
    }
  });

  it('search_tools returns typed declarations for the caller-reachable tools', async () => {
    const { client, close } = await connect(noopCaller);
    try {
      const result = (await client.callTool({
        name: SEARCH_TOOLS_TOOL_NAME,
        arguments: { query: 'wikipedia article' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('declare function external_wikipedia_article_get');
      expect(text).not.toContain('declare function external_github_repo_get');
    } finally {
      await close();
    }
  });

  it('search_tools with no query returns declarations for the whole reachable set', async () => {
    const { client, close } = await connect(noopCaller);
    try {
      const result = (await client.callTool({
        name: SEARCH_TOOLS_TOOL_NAME,
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      const text = result.content[0]?.text ?? '';
      for (const op of OPERATIONS) {
        expect(text).toContain(`external_${op.operationId}`);
      }
    } finally {
      await close();
    }
  });

  it('execute_typescript round-trips one read tool to the same result a direct full-surface call gives', async () => {
    const op = OPERATIONS.find((candidate) => candidate.slug === 'wikipedia-article.get');
    expect(op).toBeDefined();
    const caller: Caller = vi.fn(async (slug, input) => ({ slug, input, summary: 'A city.' }));

    const codemode = await connect(caller);
    const full = await connect(caller, 'full');
    try {
      const direct = (await full.client.callTool({
        name: op!.operationId,
        arguments: { title: 'Ottawa' },
      })) as CallToolResult;
      expect(direct.isError).not.toBe(true);

      const viaSandbox = (await codemode.client.callTool({
        name: EXECUTE_TYPESCRIPT_TOOL_NAME,
        arguments: {
          code: `return await external_${op!.operationId}({ title: "Ottawa" });`,
        },
      })) as CallToolResult;
      expect(viaSandbox.isError).not.toBe(true);

      // Both surfaces dispatch to the SAME `caller`, so the underlying value is
      // identical; only the envelope differs (a Code Mode result is the
      // sandbox's structured return, a direct call is the tool's own text).
      expect(direct.content[0]?.text).toContain('"summary":"A city."');
      expect(JSON.stringify(viaSandbox)).toContain('A city.');
    } finally {
      await codemode.close();
      await full.close();
    }
  });

  it('a thrown operation failure surfaces inside the sandbox as "<CODE>: <message>"', async () => {
    const failingCaller: Caller = vi.fn(async () => {
      throw Object.assign(new Error('Too many requests'), { code: 'RATE_LIMITED' });
    });
    const { client, close } = await connect(failingCaller);
    try {
      const op = OPERATIONS.find((candidate) => candidate.slug === 'wikipedia-article.get')!;
      const result = (await client.callTool({
        name: EXECUTE_TYPESCRIPT_TOOL_NAME,
        arguments: {
          code: `
            try {
              await external_${op.operationId}({ title: "Ottawa" });
              return "no error thrown";
            } catch (err) {
              return err.message;
            }
          `,
        },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('RATE_LIMITED: Too many requests');
    } finally {
      await close();
    }
  });

  it('an infinite loop is killed by the 30 second sandbox timeout', async () => {
    const { client, close } = await connect(noopCaller);
    try {
      const started = Date.now();
      const result = (await client.callTool({
        name: EXECUTE_TYPESCRIPT_TOOL_NAME,
        arguments: { code: 'while (true) {}' },
      })) as CallToolResult;
      const elapsedMs = Date.now() - started;
      // The tool CALL itself succeeds — a killed guest program is a normal
      // Code Mode outcome, reported as data (`success: false`), not an MCP
      // protocol error. `execute_typescript` returns the sandbox's own
      // envelope unchanged, matching the reference convention: only a denied
      // or failed OPERATION call is renormalized into a thrown sandbox error.
      expect(result.isError).not.toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(CODE_MODE_TIMEOUT_MS);
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('"success":false');
      expect(text.toLowerCase()).toMatch(/timed out/);
    } finally {
      await close();
    }
    // 30s sandbox timeout + generous margin for the QuickJS teardown itself.
  }, 40_000);
});

describe('MCP_TOOL_SURFACE=full keeps every existing tool-enumeration behaviour', () => {
  it('advertises one tool per public operation, exactly as createUpapiTools always has', async () => {
    const { client, close } = await connect(noopCaller, 'full');
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(OPERATIONS.length);
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        OPERATIONS.map((op) => op.operationId).sort(),
      );
    } finally {
      await close();
    }
  });

  it('runs an operation and returns its result, the same as before Code Mode existed', async () => {
    const { client, close } = await connect(noopCaller, 'full');
    try {
      const op = OPERATIONS.find((candidate) => candidate.slug === 'wikipedia-article.get')!;
      const result = (await client.callTool({
        name: op.operationId,
        arguments: { title: 'Ottawa' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('"ok":true');
    } finally {
      await close();
    }
  });
});

describe('MCP_TOOL_SURFACE=both serves the union', () => {
  it('advertises the two Code Mode tools plus every per-operation tool', async () => {
    const { client, close } = await connect(noopCaller, 'both');
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      expect(names.has(SEARCH_TOOLS_TOOL_NAME)).toBe(true);
      expect(names.has(EXECUTE_TYPESCRIPT_TOOL_NAME)).toBe(true);
      expect(tools.length).toBe(OPERATIONS.length + 2);
    } finally {
      await close();
    }
  });
});
