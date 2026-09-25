import {
  createCodeModeTool,
  createTool,
  generateStubs,
  noopObserve,
  type Tool,
} from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import type { PublicSchema } from '@mastra/core/schema';
import type { QuickJsCodeModeTransport } from '@mastra/quickjs';
import { z } from 'zod';
import { toToolFailure } from './errors.js';
import { createUpapiToolSpecs, type CreateToolsOptions, type UpapiToolSpec } from './tools.js';

/**
 * Code Mode: `search_tools` + `execute_typescript`, standing in for one MCP
 * tool per upAPI operation.
 *
 * A hosted MCP connection re-sends its whole `tools/list` result as context on
 * every turn (see `facade.ts`'s header for the same problem `search_ops` /
 * `call_op` solves). Code Mode is the more capable answer to it: instead of one
 * meta-tool per call, the model writes a short TypeScript program that reaches
 * any reachable operation through an `external_<name>` function and can batch
 * several calls into a single round trip with `Promise.all`. `search_tools`
 * hands out the TypeScript declarations; `execute_typescript` runs the program
 * in an in-process QuickJS sandbox (`@mastra/quickjs`) — no native binary, no
 * filesystem, network, or process access beyond the injected `external_*`
 * functions.
 *
 * Nothing here is a second execution path: every `external_<name>` call
 * resolves to the SAME `UpapiToolSpec.execute` the `full`/`directory`/`compact`
 * surfaces call, so auth, metering, and quota are enforced identically. A
 * denial or a thrown operation failure is normalized to `Error("<CODE>:
 * <message>")` so the guest program's own `try/catch` can branch on the code —
 * this is a SANDBOX-INTERNAL error, distinct from a malformed `execute_typescript`
 * INPUT, which fails the call itself (via zod, before the sandbox ever starts).
 * Arguments that fail an operation's own input schema are coded the same way,
 * as `INVALID_INPUT` (see `toCodeModeTool`).
 */

export const SEARCH_TOOLS_TOOL_NAME = 'search_tools';
export const EXECUTE_TYPESCRIPT_TOOL_NAME = 'execute_typescript';

/** Matches the reference Code Mode deployment this surface was ported from. */
export const CODE_MODE_TIMEOUT_MS = 30_000;

/**
 * One shared QuickJS module for every `execute_typescript` call.
 *
 * `requiresSandbox: false` — the interpreter itself is the security boundary —
 * is exactly what makes a module-level singleton safe: there is no per-call
 * workspace to isolate, only a WASM heap that is comparatively expensive to
 * spin up and is reused across calls the way a compiled regex or a DB pool
 * would be.
 *
 * Loaded on the first `execute_typescript` call, not at import time:
 * `@mastra/quickjs` is an OPTIONAL peer, so importing `@upapi/mcp/mastra` for
 * `createUpapiTools` or the `full` surface must not require it to be
 * installed. A failed load is not cached, so installing the peer and calling
 * again works without a restart.
 */
let codeModeTransport: Promise<QuickJsCodeModeTransport> | undefined;

function loadCodeModeTransport(): Promise<QuickJsCodeModeTransport> {
  codeModeTransport ??= import('@mastra/quickjs').then(
    ({ QuickJsCodeModeTransport: Transport }) => new Transport({ memoryLimitMb: 128 }),
    (err: unknown) => {
      codeModeTransport = undefined;
      throw new Error(
        `${EXECUTE_TYPESCRIPT_TOOL_NAME} needs the optional peer dependency @mastra/quickjs; install it alongside @upapi/mcp.`,
        { cause: err },
      );
    },
  );
  return codeModeTransport;
}

export const CODE_MODE_INSTRUCTIONS = `This server exposes two tools instead of one per upAPI operation:

1. ${SEARCH_TOOLS_TOOL_NAME}({ query? }): finds the upAPI operations this connection can call and
   returns them as "declare function external_<name>(...)" TypeScript signatures. Call it first;
   call it again with a narrower query if what you need was not on the first page.
2. ${EXECUTE_TYPESCRIPT_TOOL_NAME}({ code }): runs a short TypeScript program in an isolated
   sandbox. The program may call any external_* function ${SEARCH_TOOLS_TOOL_NAME} declared —
   batch independent calls with Promise.all instead of spending one round trip per operation.
   The program's final expression's value (or its explicit return, inside a function) becomes the
   tool result. Killed after 30 seconds.

Every external_* call enforces the EXACT SAME auth, metering, and quota rules the operation
enforces when called directly — Code Mode changes how a call is shaped, never what it is allowed
to do. A denied or failed call surfaces INSIDE the sandbox as a thrown Error whose message is
"<CODE>: <message>" (upAPI's public error vocabulary, the same codes every other surface renders),
so your program's own try/catch can inspect \`error.message\` and branch on the code. Arguments that
do not match an operation's declared input throw "INVALID_INPUT: <details>" the same way.`;

/**
 * One operation wrapped as a Code Mode tool.
 *
 * No `outputSchema`, matching `mastra.ts`'s `toMastraTool` and for the same
 * reason `tools.ts` gives for withholding it from `tools/list`: these schemas
 * describe live third-party payloads, and a field a worker's output has never
 * actually omitted before is not a promise this wrapper can keep. Unlike the
 * `full` surface's per-op tools, these are never registered directly on an
 * `MCPServer` — only dispatched from inside the sandbox — so the trade is
 * purely about correctness here, not about the MCP wire format.
 */
function toCodeModeTool(spec: UpapiToolSpec): Tool {
  const tool: Tool = createTool({
    id: spec.name,
    description: spec.description,
    // A JSON Schema, passed through verbatim — see `mastra.ts`'s module doc.
    inputSchema: spec.inputSchema as PublicSchema,
    execute: async (inputData: unknown) => {
      try {
        return await spec.execute(inputData);
      } catch (err) {
        const failure = toToolFailure(err);
        throw new Error(`${failure.code}: ${failure.message}`);
      }
    },
  });
  // `Tool.execute` checks the arguments against `inputSchema` BEFORE the body
  // above runs, and on a mismatch RETURNS `{ error: true, message: "Tool input
  // validation failed for <id>. …", validationErrors }` rather than throwing;
  // core's Code Mode dispatch then throws that message with no code. Re-thrown
  // here under upAPI's own `INVALID_INPUT` code so it reads like every other
  // failure the program can catch.
  const validatingExecute = tool.execute;
  if (validatingExecute) {
    tool.execute = async (inputData, context) => {
      const result: unknown = await validatingExecute.call(tool, inputData, context);
      if (isInputValidationFailure(result)) {
        throw new Error(`INVALID_INPUT: ${result.message}`);
      }
      return result;
    };
  }
  return tool;
}

function isInputValidationFailure(value: unknown): value is { message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { error, message } = value as { error?: unknown; message?: unknown };
  return (
    error === true &&
    'validationErrors' in value &&
    typeof message === 'string' &&
    message.startsWith('Tool input validation failed')
  );
}

type CodeModeCatalog = {
  specs: UpapiToolSpec[];
  toolMap: Record<string, Tool>;
};

function buildCodeModeCatalog(options: CreateToolsOptions): CodeModeCatalog {
  const specs = createUpapiToolSpecs(options);
  const toolMap: Record<string, Tool> = {};
  for (const spec of specs) {
    toolMap[spec.name] = toCodeModeTool(spec);
  }
  return { specs, toolMap };
}

const searchToolsInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Plain-word filter matched against each operation’s slug, title, description, ' +
        'category, and tags. Omit, or pass an empty string, to list every operation this ' +
        'connection can reach.',
    ),
});

const executeTypescriptInputSchema = z.object({
  code: z
    .string()
    .describe(
      'A TypeScript program. May call any external_* function search_tools declared. Runs with ' +
        'a 30 second timeout in an isolated sandbox with no filesystem, network, or process access.',
    ),
});

/**
 * Substring scoring over the fields an author already wrote — the same shape
 * `scoreOperation` in `facade.ts` uses for `search_ops`, so the two surfaces
 * behave consistently for the same query. Not imported from there: that
 * function is private to the module whose tests pin its ranking, and
 * `search_tools` only needs a match/no-match decision, not a ranked score.
 */
function matchesQuery(spec: UpapiToolSpec, query: string | undefined): boolean {
  const terms = (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [spec.slug, spec.title, spec.summary, spec.category, ...spec.tags]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * `createTool`'s return type is inferred from its concrete input schema — here
 * `searchToolsInputSchema`/`executeTypescriptInputSchema`, both zod objects —
 * so `execute`'s parameter type is a specific shape, not `unknown`. That makes
 * the result narrower than the bare `Tool` this module otherwise uses for every
 * per-op tool (whose JSON-Schema input widens to `unknown` on its own), so it
 * is widened explicitly here rather than by reaching for `any`, which the
 * repo's lint config forbids in this package. `unknown` is a safe supertype:
 * nothing downstream calls these two tools' `execute` directly — the MCP
 * server dispatches by name, using each tool's own schema — so no runtime
 * safety is actually given up.
 */
function toBareTool(tool: unknown): Tool {
  return tool as Tool;
}

function createSearchToolsTool({ specs, toolMap }: CodeModeCatalog): Tool {
  return toBareTool(
    createTool({
      id: SEARCH_TOOLS_TOOL_NAME,
      description:
        'Find the upAPI operations reachable on this connection. Returns each match as a ' +
        '"declare function external_<name>(...)" TypeScript signature to call from ' +
        `${EXECUTE_TYPESCRIPT_TOOL_NAME}.`,
      inputSchema: searchToolsInputSchema,
      mcp: {
        annotations: {
          title: 'Search Tools',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      execute: async (inputData: unknown) => {
        const { query } = searchToolsInputSchema.parse(inputData ?? {});
        const matched = specs.filter((spec) => matchesQuery(spec, query));
        const matchedTools = Object.fromEntries(
          matched.map((spec) => [spec.name, toolMap[spec.name] as Tool]),
        );
        const declarations = generateStubs(matchedTools)
          .map((stub) => stub.declaration)
          .join('\n\n');
        return { count: matched.length, declarations };
      },
    }),
  );
}

function createExecuteTypescriptTool({ toolMap }: CodeModeCatalog): Tool {
  return toBareTool(
    createTool({
      id: EXECUTE_TYPESCRIPT_TOOL_NAME,
      description:
        'Run a TypeScript program that calls the external_* functions ' +
        `${SEARCH_TOOLS_TOOL_NAME} declared. Batch independent calls with Promise.all instead of ` +
        'one round trip per operation. Killed after 30 seconds.',
      inputSchema: executeTypescriptInputSchema,
      // Reaches every write operation on the connection, so it never claims to
      // be read-only.
      mcp: {
        annotations: {
          title: 'Execute TypeScript',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      execute: async (inputData: unknown) => {
        const { code } = executeTypescriptInputSchema.parse(inputData ?? {});
        const codeModeTool = createCodeModeTool(
          { tools: toolMap, timeout: CODE_MODE_TIMEOUT_MS },
          await loadCodeModeTransport(),
        );
        if (!codeModeTool.execute) {
          throw new Error(
            `${EXECUTE_TYPESCRIPT_TOOL_NAME}: Code Mode tool was built with no execute function`,
          );
        }
        return codeModeTool.execute(
          { code },
          { observe: noopObserve, requestContext: new RequestContext() },
        );
      },
    }),
  );
}

/**
 * The Code Mode tool surface: exactly `search_tools` and `execute_typescript`,
 * bridged to the same `createUpapiToolSpecs(options)` every other surface
 * dispatches through — there is no second auth path. Two tools regardless of
 * how many operations `options` resolves to, which is the point: the
 * advertised table stays flat as the catalog grows.
 */
export function createCodeModeTools(options: CreateToolsOptions): Record<string, Tool> {
  const catalog = buildCodeModeCatalog(options);
  return {
    [SEARCH_TOOLS_TOOL_NAME]: createSearchToolsTool(catalog),
    [EXECUTE_TYPESCRIPT_TOOL_NAME]: createExecuteTypescriptTool(catalog),
  };
}
