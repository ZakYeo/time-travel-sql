# Local API v1

`npm run tts -- serve --workspace ./artifacts/workspace --json` starts the local
API and prints one readiness result containing `origin`, `endpoint` and `token`.
It creates the workspace if needed. `--port N` chooses a port; omission chooses an
available port. SIGINT/SIGTERM stop acceptance, cancel active work, close sockets
and drain owned storage workers. The configuration timeout does not limit the
server lifetime. Browser assets and journeys are not implemented yet.

Library consumers can import `startLocalApi` from `@time-travel-sql/cli` and pass
an explicit `{ workspace, port? }`. It returns `{ origin, token, closed, close }`.
`close()` is idempotent and drains owned resources. `closed` settles when cleanup
finishes and rejects on runtime server failures. Importing the library opens no
files, starts no server and reads no environment. Neither entry point connects
to a source database.

## Session and request boundary

The server binds exclusively to `127.0.0.1`. Remote binding options are rejected.
Every request requires `Authorization: Bearer TOKEN`. A token contains 256 random
bits, belongs to one running server and changes on restart. Keep the readiness
output local; tokens are capabilities. Send tokens in headers, never URL parameters.
There is no authentication cookie, permissive CORS or unauthenticated mutation.

Host must exactly match the returned origin's authority, including its port.
When Origin is present it must exactly match the returned origin. A present
Sec-Fetch-Site must be `same-origin` or `none`. Non-browser clients may omit those
browser headers but still need the token. Duplicate security headers and excess
headers are rejected explicitly; parser header storage is not silently truncated.
No request path, SQL, token or source credentials are logged by the server.

All operations use `POST /api/v1/operations`, with uncompressed
`Content-Type: application/json`. Query strings and other paths are rejected.
The request is UTF-8 JSON with `version: 1` and an `operation`. Unknown fields,
versions and operations fail. Contracts are exported by
`@time-travel-sql/contracts`, which depends only on the browser-safe SDK.

```json
{
  "version": 1,
  "operation": "query",
  "recordingId": "sample-checkout-v1",
  "selection": { "kind": "before", "position": "30" },
  "query": { "sql": "SELECT id,total FROM orders ORDER BY id" }
}
```

## Operations and response data

| Operation      | Additional request fields           | Response data                                                                           |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `sample`       | None                                | Imported sample recording view; duplicate IDs fail without replacement                  |
| `list`         | `page`                              | Recording views with `nextCursor`                                                       |
| `inspect`      | `recordingId`                       | Recording view                                                                          |
| `rename`       | `recordingId`, `name`               | Updated recording view                                                                  |
| `remove`       | `recordingId`                       | `{ recordingId, removed: true }`; only local recording data is removed                  |
| `transactions` | `recordingId`, `page`               | `{ recordingId, page }` of whole ordered transactions                                   |
| `transaction`  | `recordingId`, `position`           | `{ recordingId, transaction }` including context and ordered row events                 |
| `query`        | `recordingId`, `selection`, `query` | Selected position, columns, exact text/null rows, elapsed milliseconds and query limits |

A page is `{ "limit": 50, "cursor": null }`, with limits 1–100. Use the returned
opaque cursor with the same operation and recording. Null `nextCursor` means
completion. Each request observes recorded state; pages across requests are not
one pinned snapshot, so concurrent capture may extend later pages.

Recording views expose source/epoch, schema, status, baseline/head positions,
transaction count, name and creation time. Derived recordings retain declared
capabilities, parent configuration fingerprint and `liveResume: false` through
`derivation`; ordinary recordings have `derivation: null`. This does not assert
that an ordinary recording is ready for live resume. Storage digests, internal
SQLite rows, file paths and ownership tokens are not part of this projection.

Success is `{ version: 1, ok: true, operation, data }`. A query echoes the canonical
selection and returns its **authoritative resolved position**. For example,
`before:30` resolves to `20` in the sample; the response is never labelled `30`.
The query uses a pinned reconstructed state and a disposable read-only PGlite
workspace. Decimal and other exact values stay strings; SQL NULL is JSON null.
Duplicate column names retain their ordinal columns and row cells.

## Limits, cancellation and errors

Request headers have an 8 KiB parser cap and an explicit 40-header limit. Bodies
are limited to 128 KiB, complete responses to 16 MiB, active operations to two and
connections to 16. A slow response reader holds its operation slot. All operations
have a 30-second deadline, including body input, query work and response delivery.
Historical query limits additionally apply; see [historical SQL](historical-sql.md).
No partial query result is returned on a limit failure.

Client disconnection cancels owned reconstruction/query work. Shutdown aborts
unfinished body reads. A deadline during incomplete HTTP input may close the
connection; a completed request normally receives a timeout error. Node's parser
can reject malformed HTTP before the JSON handler. Cancellation or response loss
after a local mutation commits does not undo it; inspect recording state before
retrying a mutation. There is no hidden retry or fallback to sample data.

Application failures are `{ version: 1, ok: false, error: { code, message } }`.
Messages omit raw filesystem/driver details. HTTP status mapping:

| Status          | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| 400             | Invalid JSON, duplicate or excessive headers                        |
| 401             | Missing or invalid session token                                    |
| 403             | Host, Origin or fetch-site rejection                                |
| 404 / 405 / 415 | Unsupported path, method or content format                          |
| 408             | Request deadline                                                    |
| 413             | Request or serialized response exceeds its byte cap                 |
| 422             | Canonical domain/storage/query error; use the stable SDK error code |
| 429             | Active operation limit; retry after outstanding work finishes       |
| 500             | Unexpected internal failure, sanitized                              |
| 503             | Server stopping                                                     |

Hard total process/WASM memory containment remains an open full-project
requirement. Browser presentation, rows/diffs/lifecycles, saved scans, file sharing
and capture controls still need API/application integration. The implemented API
operations above are exercised over actual local sockets, with real storage and
historical SQL; they are not a claim of complete GOAL section 7 acceptance.

Node lifecycle reference: [Node 24 HTTP server documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html).
