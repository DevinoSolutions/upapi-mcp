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

| Variable         |          |                                                    |
| ---------------- | -------- | -------------------------------------------------- |
| `UPAPI_API_KEY`  | required | an `upapi_` key                                    |
| `UPAPI_BASE_URL` | optional | gateway origin, defaults to `https://api.upapi.io` |

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

Want every operation as its own tool instead? Add `?tools=full`:

```bash
claude mcp add --transport http upapi 'https://app.upapi.io/api/mcp?tools=full'
```

Both modes reach exactly the same operations — the mode changes what is advertised, never what is
allowed. Operations are named after their slug with `.` and `-` replaced by `_`
(`web-search.post` → `web_search_post`), and each advertises the operation's real JSON Schema
(formats, bounds, defaults, nullability), because that schema is generated from the worker's own
model and passed through untouched.

The local (stdio) server always serves one tool per operation, and the whole catalog: it is
installed deliberately, with your own key, into a client you chose.

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

The tools work in a Mastra agent directly, without an MCP transport in between:

```ts
import { Agent } from '@mastra/core/agent';
import { createGatewayCaller, createUpapiTools } from '@upapi/mcp';

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

## Build your own server

`caller` is the only thing the tool table does not supply, which is what lets the same tools run
over different transports:

```ts
import { createUpapiMcpServer, type Caller } from '@upapi/mcp';

const caller: Caller = async (slug, input) => {
  // resolve with the operation's output, or throw
  // { code, message, status?, retryAfterSeconds? }
};

await createUpapiMcpServer({ caller }).startStdio();
```

For a web-standard `Request`/`Response` server (Next.js route, Worker, Hono), import the
handler from the `/http` subpath — this is how `app.upapi.io/api/mcp` is built:

```ts
import { handleUpapiMcpRequest, type Caller } from '@upapi/mcp/http';

await handleUpapiMcpRequest(request, {
  caller,
  // mode defaults to the request's own `?tools=` parameter (compact unless `full`)
  canExecute: true, // false hides every executable tool and refuses a call to one
  canSearch: true, // false hides `search_ops`
});
```

`canExecute` / `canSearch` are how a host projects its own authorization onto the table —
upAPI maps them to the access token's `ops:execute` and `ops:read` scopes. Both default to
true, so a host without a scope model is unaffected.

Prefer that subpath over the package root in a bundled or file-traced deployment. The root
entry re-exports the Mastra bindings, so importing the handler from it pulls `@mastra/core`
and `@mastra/mcp` into a build that never runs a Mastra agent; `@upapi/mcp/http` reaches
only the MCP SDK.

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
