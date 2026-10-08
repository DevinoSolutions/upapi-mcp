import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QuickJsCodeModeTransport } from '@mastra/quickjs';
import { getQuickJS } from 'quickjs-emscripten';
import {
  CPU_BUDGET_EXCEEDED_CODE,
  CpuBudgetedQuickJsTransport,
  DEFAULT_CODE_MODE_CPU_BUDGET_MS,
  DEFAULT_CODE_MODE_TOTAL_CPU_BUDGET_MS,
} from '../code-mode-cpu-budget.js';
import { EXECUTE_TYPESCRIPT_TOOL_NAME } from '../code-mode.js';
import { createUpapiMcpServer } from '../mastra.js';
import type { Caller } from '../tools.js';

/**
 * `CpuBudgetedQuickJsTransport` (../code-mode-cpu-budget.ts) against the REAL
 * QuickJS interpreter and a real HTTP server in this same process — nothing is
 * mocked. The dispatcher stands in for the tool map `createCodeModeTool` would
 * pass, and says so by name.
 *
 * What is proven: a program that computes without awaiting is stopped within
 * the budget (not the 30s deadline) with a `CPU_BUDGET_EXCEEDED:` error; the
 * process answers other requests right after; awaiting external calls — even
 * for far longer than the budget in total — is never counted; the transport's
 * own deadline and abort still work behind the budget; and the Code Mode
 * server's `execute_typescript` really runs through it.
 *
 * Ported from uptimely (DevinoSolutions/uptimely#253).
 */

const WALL_CLOCK_TIMEOUT_MS = 20_000;
const BUDGET_ERROR = new RegExp(`^${CPU_BUDGET_EXCEEDED_CODE}: `);

const quickjsModule = await getQuickJS();

function budgeted(cpuBudgetMs?: number): CpuBudgetedQuickJsTransport {
  return new CpuBudgetedQuickJsTransport({
    Transport: QuickJsCodeModeTransport,
    module: quickjsModule,
    cpuBudgetMs,
  });
}

/**
 * Stand-in for the tool map: `external_wait({ ms, value })` resolves with
 * `value` after `ms` of real (timer) time; `external_never()` never resolves.
 */
function waitingDispatcher(tool: string, args: unknown): Promise<unknown> {
  if (tool === 'never') return new Promise<never>(() => {});
  const { ms, value } = args as { ms: number; value: unknown };
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function run(
  transport: CpuBudgetedQuickJsTransport,
  program: string,
  options: { timeout?: number; abortSignal?: AbortSignal } = {},
) {
  return transport.run({
    program,
    toolIds: ['wait', 'never'],
    dispatch: waitingDispatcher,
    timeout: options.timeout ?? WALL_CLOCK_TIMEOUT_MS,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  const value = await work();
  return { value, ms: performance.now() - startedAt };
}

describe('a program that computes without awaiting is stopped by the CPU budget', () => {
  const transport = budgeted(300);

  it('while (true) {} ends with CPU_BUDGET_EXCEEDED shortly after the budget, not at the wall-clock timeout', async () => {
    const { value: result, ms } = await timed(() => run(transport, 'while (true) {}'));

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(BUDGET_ERROR);
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThan(300 + 2_000);
  }, 10_000);

  it('a loop that only awaits guest promises (for (;;) await null) never returns to the host and is stopped the same way', async () => {
    const { value: result, ms } = await timed(() => run(transport, 'for (;;) { await null; }'));

    expect(result.error?.message).toMatch(BUDGET_ERROR);
    expect(ms).toBeLessThan(300 + 2_000);
  }, 10_000);

  it('a loop started after an awaited external call is stopped too, and keeps the console output logged before it', async () => {
    const result = await run(
      transport,
      `const v = await external_wait({ ms: 50, value: "ready" });
       console.log("got", v);
       while (true) {}`,
    );

    expect(result.error?.message).toMatch(BUDGET_ERROR);
    expect(result.logs).toEqual(['got ready']);
  }, 10_000);

  it("the program's own try/catch and finally cannot swallow the interrupt", async () => {
    const result = await run(
      transport,
      `try { while (true) {} } catch (e) { return "caught"; } finally { return "finally"; }`,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(BUDGET_ERROR);
  }, 10_000);

  it('the next program on the same transport runs normally after one was stopped', async () => {
    await run(transport, 'while (true) {}');

    const result = await run(transport, 'return 1 + 1;');

    expect(result).toMatchObject({ success: true, result: 2 });
  }, 10_000);
});

describe('the process keeps serving while a runaway program is stopped', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('pong'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it('an HTTP request sent while while (true) {} runs is answered right after the budget, far inside the wall-clock timeout', async () => {
    const transport = budgeted(500);
    // Warm: a first run() pays one-off costs, and the request would be answered
    // during them, before the loop even started.
    await run(transport, 'return 0;');
    const startedAt = performance.now();

    const program = run(transport, 'while (true) {}');
    const answeredAt = fetch(url)
      .then((res) => res.text())
      .then((body) => ({ body, ms: performance.now() - startedAt }));
    const [result, answer] = await Promise.all([program, answeredAt]);

    expect(result.error?.message).toMatch(BUDGET_ERROR);
    expect(answer.body).toBe('pong');
    // It really waited on the loop (the loop held the event loop)...
    expect(answer.ms).toBeGreaterThanOrEqual(500);
    // ...and was served as soon as the budget stopped it. Unbudgeted, the
    // request waits out the whole 20s wall-clock timeout.
    expect(answer.ms).toBeLessThan(500 + 2_000);
  }, 10_000);

  it('a second program awaiting an external call completes while another program loops', async () => {
    const transport = budgeted(500);

    const [looping, waiting] = await Promise.all([
      run(transport, 'while (true) {}'),
      run(transport, `return await external_wait({ ms: 100, value: "finished" });`),
    ]);

    expect(looping.error?.message).toMatch(BUDGET_ERROR);
    expect(waiting).toMatchObject({ success: true, result: 'finished' });
  }, 10_000);
});

describe('time spent awaiting external calls is never counted against the budget', () => {
  it('a program awaiting several external calls for far longer than the default budget in total succeeds', async () => {
    const transport = budgeted();
    const program = `
      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push(await external_wait({ ms: 450, value: i }));
      }
      const [a, b] = await Promise.all([
        external_wait({ ms: 450, value: "a" }),
        external_wait({ ms: 450, value: "b" }),
      ]);
      return [...results, a, b];
    `;

    const { value: result, ms } = await timed(() => run(transport, program));

    expect(ms).toBeGreaterThan(DEFAULT_CODE_MODE_CPU_BUDGET_MS);
    expect(ms).toBeGreaterThan(2_000);
    expect(result).toMatchObject({ success: true, result: [0, 1, 2, 3, 'a', 'b'] });
  }, 15_000);

  it('computing for longer than the budget in total succeeds when every stretch between awaits stays under it', async () => {
    const transport = budgeted(500);
    const program = `
      let stretches = 0;
      for (let i = 0; i < 4; i++) {
        const until = Date.now() + 250;
        while (Date.now() < until) {}
        stretches++;
        await external_wait({ ms: 10, value: null });
      }
      return stretches;
    `;

    const { value: result, ms } = await timed(() => run(transport, program));

    expect(ms).toBeGreaterThan(1_000);
    expect(result).toMatchObject({ success: true, result: 4 });
  }, 15_000);
});

describe('the total CPU cap stops a compute -> await -> compute loop', () => {
  function capped(cpuBudgetMs: number, totalCpuBudgetMs: number): CpuBudgetedQuickJsTransport {
    return new CpuBudgetedQuickJsTransport({
      Transport: QuickJsCodeModeTransport,
      module: quickjsModule,
      cpuBudgetMs,
      totalCpuBudgetMs,
    });
  }

  it('every stretch stays under the per-slice budget, but the summed compute passes the total cap', async () => {
    const program = `
      for (let i = 0; i < 20; i++) {
        const until = Date.now() + 200;
        while (Date.now() < until) {}
        await external_wait({ ms: 10, value: null });
      }
      return "finished";
    `;

    const { value: result, ms } = await timed(() => run(capped(400, 800), program));

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(BUDGET_ERROR);
    expect(result.error?.message).toContain('in total');
    expect(result.error?.message).not.toContain('without awaiting');
    expect(ms).toBeGreaterThanOrEqual(800);
    expect(ms).toBeLessThan(800 + 1_500);
  }, 15_000);

  it('awaited time is excluded: the same loop under a generous total cap finishes', async () => {
    const program = `
      for (let i = 0; i < 3; i++) {
        const until = Date.now() + 200;
        while (Date.now() < until) {}
        await external_wait({ ms: 300, value: null });
      }
      return "finished";
    `;

    const result = await run(capped(400, 5_000), program);

    expect(result).toMatchObject({ success: true, result: 'finished' });
  }, 15_000);

  it('the default total cap is 5s', () => {
    expect(DEFAULT_CODE_MODE_TOTAL_CPU_BUDGET_MS).toBe(5_000);
  });
});

describe("the transport's own deadline and abort still work behind the budget", () => {
  it("a program waiting on a call that never resolves still ends with the transport's own TimeoutError", async () => {
    const transport = budgeted(5_000);

    const result = await run(transport, 'return await external_never();', { timeout: 400 });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('TimeoutError');
  }, 10_000);

  it("the caller's own abort still ends the program with the transport's AbortError, not CPU_BUDGET_EXCEEDED", async () => {
    const transport = budgeted(5_000);
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);

    const result = await run(transport, 'return await external_never();', {
      abortSignal: caller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('AbortError');
  }, 10_000);
});

describe("the Code Mode server's execute_typescript runs through the budget", () => {
  type CallToolResult = { isError?: boolean; content: Array<{ text: string }> };
  const caller: Caller = vi.fn(async () => ({ ok: true }));

  it('while (true) {} comes back as CPU_BUDGET_EXCEEDED after the default budget, and the next call still works', async () => {
    const server = createUpapiMcpServer({ caller, surface: 'codemode' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([
      server.getServer().connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { value: runaway, ms } = await timed(
        async () =>
          (await client.callTool({
            name: EXECUTE_TYPESCRIPT_TOOL_NAME,
            arguments: { code: 'while (true) {}' },
          })) as CallToolResult,
      );
      expect(JSON.stringify(runaway.content)).toContain(`${CPU_BUDGET_EXCEEDED_CODE}: `);
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_CODE_MODE_CPU_BUDGET_MS);
      expect(ms).toBeLessThan(DEFAULT_CODE_MODE_CPU_BUDGET_MS + 2_000);

      const next = (await client.callTool({
        name: EXECUTE_TYPESCRIPT_TOOL_NAME,
        arguments: { code: 'return 1 + 1;' },
      })) as CallToolResult;
      expect(next.isError).not.toBe(true);
      expect(next.content[0]?.text).toContain('2');
    } finally {
      await client.close();
      await server.close();
    }
  }, 15_000);
});

// The budget relies on two @mastra/quickjs 0.1.1 internals (see the header of
// code-mode-cpu-budget.ts). The behavioural tests above fail if either breaks;
// this makes a version bump itself a loud, deliberate step.
describe('the @mastra/quickjs build the budget was proven against', () => {
  const require = createRequire(import.meta.url);
  const quickjsPackageJson = require.resolve('@mastra/quickjs/package.json');

  it('@mastra/quickjs is exactly 0.1.1 — re-prove code-mode-cpu-budget.ts before changing it', () => {
    expect((require(quickjsPackageJson) as { version: string }).version).toBe('0.1.1');
  });

  it('the quickjs-emscripten this package loads the module from is the same version @mastra/quickjs itself resolves', () => {
    const fromQuickjs = createRequire(quickjsPackageJson);
    const theirs = fromQuickjs('quickjs-emscripten/package.json') as { version: string };
    const ours = require('quickjs-emscripten/package.json') as { version: string };

    expect(ours.version).toBe(theirs.version);
    expect(ours.version).toBe('0.31.0');
  });
});
