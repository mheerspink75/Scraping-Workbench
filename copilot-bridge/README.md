# Copilot Bridge

A small, local-only HTTP forwarding service for the sandboxed Browser Interaction
API. It is implemented in TypeScript with Express, Zod, and the built-in
`fetch` API.

The Bridge has **no Playwright dependency and no browser access**. It validates
Copilot envelopes, maps a fixed allowlist of logical endpoints to fixed local
routes, forwards only selected headers, and returns the upstream status/body
without interpretation.

## Requirements

- Node.js 20+
- The Browser Interaction API running on `127.0.0.1:8787` by default

```bash
cd copilot-bridge
npm install
npm run build
```

## Run

```bash
export BRIDGE_PORT=8790
export BROWSER_API_PORT=8787
export BROWSER_API_SECRET='same-secret-configured-on-browser-api'
export BROWSER_APPROVAL_SECRET='human-approval-secret'
export BRIDGE_API_SECRET='secret-for-copilot-to-call-bridge' # optional but recommended

npm start
```

The Bridge binds only to `127.0.0.1`.

## Main endpoint

```http
POST /copilot/bridge
Content-Type: application/json
```

```json
{
  "endpoint": "browser.query",
  "payload": {
    "selector": "#results",
    "tabId": 1
  }
}
```

Session-scoped requests must also include:

```http
x-browser-session: <session UUID>
```

Mutating actions must include exactly one permission-token channel:

```http
x-permission-token: <one-time token>
```

The token may instead be `payload.permissionToken` for a single action/eval,
but the header and body token must not both be present. Workflows must put a
separate token on every mutating step; a workflow-wide token is rejected.
Read-only actions cannot carry tokens.

The Bridge never creates, caches, extends, or reuses permission tokens.

## Endpoint mapping

| Copilot endpoint | Browser API route |
|---|---|
| `browser.session.start` | `POST /browser/session/start` |
| `browser.session.end` | `POST /browser/session/end` |
| `browser.dom` | `GET /browser/dom?tabId=...` |
| `browser.query` | `POST /browser/query` |
| `browser.action` | `POST /browser/action` |
| `browser.eval` | `POST /browser/eval` |
| `browser.workflow` | `POST /browser/workflow` |
| `browser.permission.request` | `POST /browser/permission/request` |
| `browser.permission.approve` | `POST /browser/permission/approve` |
| `browser.permission.deny` | `POST /browser/permission/deny` |

All payload schemas are strict Zod schemas in
[`src/contracts.ts`](src/contracts.ts). Unknown endpoints return exactly:

```json
{"error":{"code":"INVALID_ENDPOINT","message":"Unsupported endpoint"}}
```

Unknown fields, missing action-specific fields, invalid UUIDs, and
prototype-related keys are rejected before any network call.

## Approval forwarding

The Bridge never auto-approves and never adds the Browser API approval secret on
Copilot's behalf. The approval endpoints require an explicit matching header:

```http
x-browser-approval-secret: <human approval secret>
```

The secret is checked against `BROWSER_APPROVAL_SECRET`, then forwarded only to
the approval/deny route. Keep this secret out of the Copilot process; a separate
human approval UI should inject it. Copilot may not choose `ttlMs`; requests that
attempt to set an approval lifetime are rejected.

## Security boundaries

- The upstream URL is always `http://127.0.0.1:<BROWSER_API_PORT>`.
- Payloads cannot provide a host, port, path, method, or redirect target.
- Redirects are rejected with `redirect: 'error'`.
- No cookies, authorization headers, forwarding headers, or arbitrary incoming
  headers are copied upstream.
- `BROWSER_API_SECRET` is added by the Bridge from server configuration; a
  caller-provided API secret is not trusted or forwarded.
- `BRIDGE_API_SECRET`, when configured, authenticates callers to the Bridge via
  `x-bridge-api-secret`.
- Response bodies are size-limited and upstream status/body/content type are
  relayed without JSON reinterpretation.
- The Bridge does not import or invoke Playwright, open pages, evaluate scripts,
  mutate DOM, or navigate URLs.

## Health

```http
GET /copilot/bridge/health
```

```json
{"status":"ok","browserApiReachable":true}
```

`browserApiReachable` is false when the fixed Browser API health check cannot be
reached. The Bridge itself remains up so Copilot can distinguish a dependency
failure from a dead Bridge process.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `BRIDGE_PORT` | `8790` | Bridge listen port |
| `BROWSER_API_PORT` | `8787` | Browser API port; host is always `127.0.0.1` |
| `BROWSER_API_SECRET` | empty | Secret automatically sent to Browser API |
| `BROWSER_APPROVAL_SECRET` | empty | Required to forward approval/deny requests |
| `BRIDGE_API_SECRET` | empty | Optional secret required from Bridge callers |
| `BRIDGE_FORWARD_TIMEOUT_MS` | `35000` | Upstream fetch timeout |
| `BRIDGE_MAX_BODY_BYTES` | `262144` | Incoming JSON limit |
| `BRIDGE_MAX_RESPONSE_BYTES` | `2097152` | Upstream response limit |

## Tests

```bash
npm run lint
npm test
```

Tests cover all endpoint mappings, strict payload validation, fixed-origin
forwarding, session/token requirements, approval behavior, token conflicts,
prototype-key rejection, upstream passthrough, network failures, response caps,
and Bridge API-secret protection.

### WSL note

The project includes a root-aware runner so Windows `npm` can execute the
scripts from a WSL UNC checkout. If a harmless `UNC paths are not supported`
warning appears, use `./run-linux.sh build`, `./run-linux.sh test`, or
`./run-linux.sh start` when a native Linux Node installation is available.
