# Sandboxed Browser Interaction API

A small, local-first HTTP API for controlled browser automation. It is written in
TypeScript, uses Express for HTTP and Playwright for browser automation, and is
self-contained under this directory.

The service is intentionally conservative:

- every session gets a fresh Playwright `BrowserContext` and one current tab;
- no persistent profile, browser extensions, downloads, WebSockets, or stored
  credentials are loaded;
- only `http`, `https`, and `about:blank` navigation is accepted;
- private/link-local destinations, including loopback, are blocked by default;
- mutating actions require a one-time, expiring permission token scoped to the
  session, tab, and action;
- the agent cannot approve its own requests: approval requires a separate
  `BROWSER_APPROVAL_SECRET`;
- eval code never receives the raw Playwright `page` object, browser globals, or
  host objects. The adapter takes a bounded, redacted page read model and runs the
  script in a QuickJS WebAssembly isolate with memory, stack, and time limits;
  no Node `vm`, filesystem, process, or network bindings are exposed. Normal
  page navigation remains subject to the separate browser URL/network policy.

## Requirements

- Node.js 20 or newer
- Chromium installed for Playwright

```bash
cd browser-api
npm install
npx playwright install chromium
```

For the local integration tests, the fixture server uses loopback. Set
`BROWSER_ALLOW_PRIVATE_NETWORKS=true` only in an isolated development or test
environment.

### WSL note

If `npm` resolves to the Windows Node installation under `/mnt/c/Program Files`,
Windows `cmd.exe` may print a harmless `UNC paths are not supported` warning.
The checked-in `scripts/run.cjs` resolves the project through npm's
`npm_config_local_prefix`, so `npm run build`, `npm run lint`, and unit tests work
from a WSL checkout. For the real Linux Chromium runtime/integration test, use a
Linux Node installation (or install the Windows Playwright browser when using
Windows Node). A convenience wrapper is included for native Linux execution:

```bash
./run-linux.sh build
./run-linux.sh test
./run-linux.sh start
```

## Run

```bash
export BROWSER_API_SECRET='optional-api-secret-for-non-health-endpoints'
export BROWSER_APPROVAL_SECRET='replace-with-a-long-random-secret'
export BROWSER_API_PORT=8787
npm run build
npm start
```

The API binds to `127.0.0.1` by default. Do not expose it publicly without adding an authenticated front proxy and a
separate approval UI. Keep `BROWSER_CHROMIUM_SANDBOX=true` in deployment and run
Chromium as a non-root user; the integration test disables it only to work in a
local development container.

## Session and tab headers

If `BROWSER_API_SECRET` is set, send it on every non-health endpoint:

```http
x-browser-api-secret: <API secret>
```

After session start, all session-scoped endpoints require:

```http
x-browser-session: <session UUID>
```

`tabId` is an integer returned by session start. The minimal profile exposes one
current tab per session. A request for any other tab is rejected with
`TAB_NOT_ACCESSIBLE`; popups are closed rather than exposed.

## Permissions

Only `click`, `type`, `navigate`, and `evaluate` are mutating actions. They fail
with `PERMISSION_REQUIRED` unless a token is supplied in either the request body
(`permissionToken`) or `x-permission-token`.

The agent can create a pending request:

```http
POST /browser/permission/request
x-browser-session: <session UUID>
content-type: application/json

{"action":"click","tabId":1,"selector":"#submit","reason":"Click the submit button"}
```

A separate trusted approval client then approves it:

```http
POST /browser/permission/approve
x-browser-approval-secret: <BROWSER_APPROVAL_SECRET>
content-type: application/json

{"requestId":"<request UUID>"}
```

The response contains a token, scope, operation digest, and expiry. Tokens are
single-use and are also invalidated when the session ends. A token for `click`
cannot be used for `type`, another selector/value/code operation, another tab, or
another session. The approval request summary exposes text length rather than
secret text or source code.

## Endpoints

All request and response types are defined in [`src/contracts.ts`](src/contracts.ts).
Validation is performed with Zod at the HTTP boundary. A complete OpenAPI 3.1
description is available in [`openapi.yaml`](openapi.yaml).

### `POST /browser/session/start`

Starts an isolated context and returns:

```json
{
  "sessionId": "uuid",
  "tabId": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-01-01T01:00:00.000Z",
  "permissions": { "pending": 0, "active": 0 }
}
```

Optional body: `{ "metadata": { "label": "example" } }`.

### `POST /browser/session/end`

Closes the context, invalidates permissions, and marks the session unavailable.
Requires `x-browser-session`; body may be `{}` or `{ "sessionId": "..." }`.

### `GET /browser/dom?tabId=<id>`

Returns a bounded snapshot of visible elements, safe attributes, title, redacted
URL, visibility, and bounding rectangles. Form values, scripts, storage, cookies,
and unrestricted HTML are not returned.

### `POST /browser/query`

```json
{"selector":"button.primary","tabId":1}
```

Returns matched elements, safe attributes, text, visibility, and rectangles.
Invalid selectors return `400 INVALID_SELECTOR`.

### `POST /browser/action`

Supported actions are `click`, `type`, `navigate`, `scroll`, `extract`,
`evaluate`, `waitFor`, and `screenshot`.

```json
{
  "action": "type",
  "selector": "#email",
  "text": "user@example.test",
  "url": null,
  "tabId": 1,
  "permissionToken": "browser-permission-..."
}
```

- `navigate` requires `url` and a `navigate` token.
- `click` and `type` require a selector and their matching token.
- `type` uses a bounded fill operation and never returns the field value.
- `evaluate` treats `text` as JavaScript and requires an `evaluate` token.
- `scroll`, `extract`, `waitFor`, and `screenshot` are read-only actions.
- Screenshots are returned as base64 PNG data and are size-limited.

### `POST /browser/eval`

```json
{
  "code": "document.querySelector('#title').text",
  "tabId": 1,
  "permissionToken": "browser-permission-..."
}
```

The script receives only a frozen read model with `document.title`,
`document.URL`, `document.bodyText`, and simple `querySelector`,
`querySelectorAll`, and `getElementById` helpers. `window`, `fetch`, cookies,
storage, workers, browser settings, extensions, timers, and constructors are
blocked. Scripts are synchronous, parsed before execution, limited to 50 KB, and
time-limited.

### `POST /browser/workflow`

Executes steps sequentially in one session. Each mutating step carries its own
permission token; there is no workflow-wide bypass.

```json
{
  "steps": [
    {"action":"navigate","url":"https://example.test","selector":null,"text":null,"tabId":1,"permissionToken":"..."},
    {"action":"click","selector":"#submit","text":null,"url":null,"tabId":1,"permissionToken":"..."}
  ],
  "stopOnError": true
}
```

The response includes `workflowId`, ordered step results, current step, and a
status of `running`, `completed`, `failed`, or `denied`. State is available at
`GET /browser/workflow/:workflowId` with the session header.

## Permission administration endpoints

These are intentionally separate from the agent action surface:

- `POST /browser/permission/request` — create a pending request (agent-safe).
- `GET /browser/permissions` — list pending requests for the approval UI; requires the secret.
- `POST /browser/permission/approve` — issue a token; requires the approval secret.
- `POST /browser/permission/deny` — reject a pending request; requires the secret.
- `GET /browser/session` — inspect the current session.
- `GET /browser/sessions` — administrative session listing; also requires the secret.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `BROWSER_API_HOST` | `127.0.0.1` | Bind address |
| `BROWSER_HEADLESS` | `true` | Run Chromium headless |
| `BROWSER_API_PORT` | `8787` | HTTP port |
| `BROWSER_API_SECRET` | empty | Optional API bearer secret for all non-health endpoints |
| `BROWSER_APPROVAL_SECRET` | empty | Required for approval; empty disables approval |
| `BROWSER_SESSION_TTL_MS` | `3600000` | Session lifetime |
| `BROWSER_PERMISSION_TTL_MS` | `60000` | Maximum token lifetime |
| `BROWSER_ALLOW_PRIVATE_NETWORKS` | `false` | Allow RFC1918/private destinations |
| `BROWSER_ALLOWED_HOSTS` | empty | Optional strict exact/`*.domain` destination allowlist |
| `BROWSER_CHROMIUM_SANDBOX` | `true` | Keep Chromium sandbox enabled |
| `BROWSER_EXECUTABLE_PATH` | Playwright default | Optional Chromium executable |
| `BROWSER_EVAL_TIMEOUT_MS` | `250` | Maximum eval execution time |

## Tests

```bash
npm run lint
npm test
```

Unit tests use a fake browser backend and cover every endpoint, permissions,
workflow state, URL policy, and sandbox escapes. The integration test starts a
local fixture site and exercises real Chromium navigation, DOM/query inspection,
click/type, screenshots, sandboxed eval, and sequential workflows.
