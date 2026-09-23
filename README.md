# @upapi/mcp

Every public [upAPI](https://upapi.io) operation as an [MCP](https://modelcontextprotocol.io)
tool — web search, SERP, social profiles, dev-tool lookups, geo/finance data — so an agent can
call them directly.

There are two ways to connect, and they differ only in how a call is authenticated:

|          | Local (stdio)                   | Hosted (HTTP)                                 |
| -------- | ------------------------------- | --------------------------------------------- |
| Endpoint | `npx @upapi/mcp`                | `https://app.upapi.io/api/mcp`                |
| Auth     | your `upapi_` API key           | sign in with your upAPI account (OAuth)       |
| Runs     | on your machine                 | on upAPI                                      |
| Best for | scripts, CI, self-hosted agents | Claude, IDEs, anything that speaks remote MCP |

Both expose the same tools with the same schemas, and both bill the same quota.

## Hosted — no install

Point any MCP client that supports remote servers at:

```
https://app.upapi.io/api/mcp
```

It will walk you through signing in to upAPI in a browser; there is no key to copy. With Claude
Code:

```bash
claude mcp add --transport http upapi https://app.upapi.io/api/mcp
```

## Local — API key

Create a key at [app.upapi.io → API Keys](https://app.upapi.io/dashboard/api-keys), then:

```bash
claude mcp add upapi -e UPAPI_API_KEY=upapi_xxx -- npx -y @upapi/mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor, and Windsurf take the same thing as JSON:

```json
{
  "mcpServers": {
    "upapi": {
      "command": "npx",
      "args": ["-y", "@upapi/mcp"],
      "env": { "UPAPI_API_KEY": "upapi_xxx" }
    }
  }
}
```

| Variable          |          |                                                        |
| ----------------- | -------- | ------------------------------------------------------ |
| `UPAPI_API_KEY`   | required | an `upapi_` key                                        |
| `UPAPI_BASE_URL`  | optional | gateway origin, defaults to `https://api.upapi.io`     |
| `UPAPI_TOOL_MODE` | optional | `compact` (default), `directory` or `full` — see Tools |

The key is never validated locally — only checked for presence, so a missing one fails
immediately with a readable message instead of surfacing later as an unexplained 401 inside a
tool call. Whether a key is real, expired, or over quota is answered at the gateway, the single
place that answers it for every machine caller.

## Tools

The hosted endpoint serves a **compact** table by default: two meta-tools plus a few always-on
operations, a few kilobytes in total.

| Tool         | What it does                                                                      |
| ------------ | --------------------------------------------------------------------------------- |
| `search_ops` | Find operations by intent — returns slug, description, parameters, and quota cost |
| `call_op`    | Run one operation by slug: `{ "slug": "github-repo.get", "input": { … } }`        |

A tool table is re-sent as context on every turn, so one tool per operation means tens of
kilobytes of JSON Schema per turn and a table large enough to measurably degrade tool selection.
`search_ops` + `call_op` stays flat as the catalog grows. `web-search.post`, `github-repo.get`,
and `wikipedia-article.get` stay on the table as full tools so the common case needs no discovery
round-trip.

There are two other tables. `?tools=full` gives every operation its own tool:

```bash
claude mcp add --transport http upapi 'https://app.upapi.io/api/mcp?tools=full'
```

`?tools=directory` gives a curated set of **named** tools for the flagship operations — the Maps
trio, web search, page-to-Markdown, screenshot, HTML-to-PDF, PDF text, OCR, transcription, GitHub
repo/user, npm package, IP geolocation, Wikipedia, currency — with read tools and write tools
listed separately and no `call_op`. That is the shape AI-directory review criteria ask for (a
catch-all dispatcher with a target parameter is a rejection), and it is what the Claude Desktop
Extension ships with. The local stdio server takes the same three names in `UPAPI_TOOL_MODE`,
defaulting to `compact` — the same few-kilobyte shape the hosted endpoint defaults to. `full`
remains available (`UPAPI_TOOL_MODE=full`) as the rollback for a client already configured
against the one-tool-per-operation shape this server used to default to.

All three modes reach exactly the same operations — the mode changes what is advertised, never
what is allowed. Every tool in every mode carries `readOnlyHint`, `destructiveHint`,
`idempotentHint` and `openWorldHint`, derived from what the worker does rather than from the
slug's verb suffix. Operations are named after their slug with `.` and `-` replaced by `_`
(`web-search.post` → `web_search_post`), and each advertises the operation's real JSON Schema
(formats, bounds, defaults, nullability), because that schema is generated from the worker's own
model and passed through untouched.

The local (stdio) server reaches the whole catalog in `compact` and `full` mode — it is installed
deliberately, with your own key, into a client you chose. Its `directory` mode applies the same
withheld-category exclusion the hosted endpoint's `directory` mode does, since that mode is what a
public listing (like the Claude Desktop Extension) advertises to someone who has not made that
choice yet.

Descriptions carry the quota cost, so an agent can budget:

> Search the web… upAPI operation `web-search.post` (Search). Costs 25 units of monthly quota
> per call.

A failed operation comes back as a normal tool result with `isError: true` and text leading with
upAPI's public error code — `RATE_LIMITED`, `INVALID_INPUT`, `UPSTREAM_UNREACHABLE`. A rate limit
also states the wait in seconds. Nothing about a failing operation breaks the session.

No `outputSchema` is declared, deliberately: MCP requires a server that declares one to return
matching `structuredContent`, and these outputs describe live third-party payloads. One
unexpected null would turn a successful call into a protocol error.

## Use it from Mastra

The tools work in a Mastra agent directly, without an MCP transport in between. `@mastra/core` and
`@mastra/mcp` are **optional peer dependencies** — install them yourself, and import the bindings
from the `/mastra` subpath. Nothing else in this package touches Mastra, which is what keeps a
plain `npm i @upapi/mcp` (and the desktop-extension bundle built from it) small.

```ts
import { Agent } from '@mastra/core/agent';
import { createGatewayCaller } from '@upapi/mcp';
import { createUpapiTools } from '@upapi/mcp/mastra';

const agent = new Agent({
  name: 'researcher',
  instructions: 'Research topics using upAPI.',
  model: /* … */,
  tools: createUpapiTools({
    caller: createGatewayCaller({ apiKey: process.env.UPAPI_API_KEY! }),
  }),
});
```

Narrow the table with `filter` when an agent should only see part of the catalog:

```ts
createUpapiTools({
  caller,
  filter: (op) => op.category === 'Search',
});
```

### `createUpapiMcpServer` — Code Mode by default

`createUpapiMcpServer` builds a Mastra `MCPServer` (`@mastra/mcp`, also an optional peer). Its
**default tool surface is Code Mode**: `search_tools` + `execute_typescript` instead of one tool
per operation — measured on the full 99-operation catalog, `tools/list` drops from **111,016
bytes to 1,069 bytes** (99 tools → 2), because the table no longer grows with the catalog at all.

```ts
import { createGatewayCaller } from '@upapi/mcp';
import { createUpapiMcpServer } from '@upapi/mcp/mastra';

const server = createUpapiMcpServer({
  caller: createGatewayCaller({ apiKey: process.env.UPAPI_API_KEY! }),
});

await server.startStdio();
```

- **`search_tools({ query? })`** finds the operations this connection can reach and returns them
  as `declare function external_<name>(...)` TypeScript signatures.
- **`execute_typescript({ code })`** runs a short TypeScript program in an isolated QuickJS sandbox
  (`@mastra/quickjs`, another optional peer — no native binary, no filesystem/network/process
  access beyond the injected `external_*` functions). Batch several operations into one round trip
  with `Promise.all` instead of one tool call each. Killed after 30 seconds.

Every `external_*` call resolves to the exact same `createUpapiTools(options)` tool object the
`full` surface (below) calls — there is no second auth path. A denied or failed operation call
surfaces **inside the sandbox** as a thrown `Error("<CODE>: <message>")`, so the guest program's
own `try`/`catch` can inspect and branch on the code; that is separate from a malformed
`execute_typescript` **input**, which fails the call itself before the sandbox ever starts.

Set `MCP_TOOL_SURFACE` (or pass `surface`) to change what is advertised:

| Value                  | Advertises                                                | When to use it                                            |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `codemode` _(default)_ | `search_tools` + `execute_typescript`                     | Any model that can write a few lines of TypeScript        |
| `full`                 | One tool per operation — today's `createUpapiTools` table | Rollback switch, or a client already built against it     |
| `both`                 | The union of the two                                      | Exercising or migrating off of one surface mid-transition |

```bash
MCP_TOOL_SURFACE=full node my-server.js   # one tool per operation, the pre-Code Mode shape
```

```ts
createUpapiMcpServer({ caller, surface: 'full' }); // same thing, set in code instead of env
```

`instructions` on the server carries the Code Mode contract automatically whenever a `codemode`
tool is on the table (`codemode` and `both`) — a model was not told to write TypeScript against
`search_tools`/`execute_typescript` otherwise.

## Build your own server

`caller` is the only thing the tool table does not supply, which is what lets the same tools run
over different transports:

```ts
import { startUpapiStdioServer, type Caller } from '@upapi/mcp';

const caller: Caller = async (slug, input) => {
  // resolve with the operation's output, or throw
  // { code, message, status?, retryAfterSeconds? }
};

await startUpapiStdioServer({ caller, mode: 'directory' });
```

For a web-standard `Request`/`Response` server (Next.js route, Worker, Hono), import the
handler from the `/http` subpath — this is how `app.upapi.io/api/mcp` is built:

```ts
import { handleUpapiMcpRequest, type Caller } from '@upapi/mcp/http';

await handleUpapiMcpRequest(request, {
  caller,
  // mode defaults to the request's own `?tools=` parameter (compact unless `full`/`directory`)
  canExecute: true, // false hides every executable tool and refuses a call to one
  canSearch: true, // false hides `search_ops`
});
```

`canExecute` / `canSearch` are how a host projects its own authorization onto the table —
upAPI maps them to the access token's `ops:execute` and `ops:read` scopes. Both default to
true, so a host without a scope model is unaffected.

Prefer that subpath over the package root in a bundled or file-traced deployment: it reaches only
the MCP SDK, while the root entry also pulls the stdio server in. Neither reaches Mastra — the
bindings live behind `@upapi/mcp/mastra` precisely so that a build which never runs a Mastra agent
never sees `@mastra/core`.

## Related

- [`@upapi/sdk`](https://github.com/DevinoSolutions/upapi-node) — the typed HTTP client, and the operation catalog this package's tool
  table is generated from
- [upapi.io/docs](https://upapi.io/docs) — operation reference

## Where development happens

This repository is the published home of `@upapi/mcp`: it is what npm installs, and
issues and pull requests are welcome here. The tool table is derived from the
operation catalog in [`@upapi/sdk`](https://github.com/DevinoSolutions/upapi-node),
which is itself generated from upAPI’s private operation definitions and synced
automatically — so the set of tools changes upstream. The server, facade, error
mapping and tests in these files are hand-written and are the code to change.
