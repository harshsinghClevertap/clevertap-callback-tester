# CleverTap Callback Tester

A small web app for SMS and WhatsApp providers integrating with CleverTap. Enter a callback URL and the `msgId` you received from CleverTap, click a status button, and the matching delivery-status callback is POSTed to that URL. No real message is sent.

- **Channels and statuses:** SMS (Delivered, Clicked) and WhatsApp (Delivered, Viewed, Clicked)
- **Payloads** follow CleverTap's published formats:
  [Generic SMS](https://docs.clevertap.com/docs/generic-sms) and
  [Generic WhatsApp](https://docs.clevertap.com/docs/generic-whatsapp#message-status-callbacks)
- **No database.** Callback URLs, msgIds and responses are never stored on the server. Session history lives in the browser tab's memory only.
- **No npm dependencies.** The server uses only Node's built-in modules (Node 20 or newer).

## Quick start

```bash
npm start            # http://localhost:3000
npm test             # unit and integration tests (Node's built-in test runner)
```

With Docker:

```bash
docker build -t clevertap-callback-tester .
docker run --rm -p 3000:3000 clevertap-callback-tester
```

## Using it

1. Pick **SMS** or **WhatsApp**.
2. Enter the **Callback URL**. This is the Delivery Report Callback URL from your CleverTap provider setup, or a [webhook.site](https://webhook.site) URL while you are checking the payload.
3. Enter the **msgId** CleverTap sent with the outbound message.
   - SMS: the value of `$$MessageID` (sent back as `meta`).
   - WhatsApp: the `msgId` field of the outbound payload (sent back as `msgId`).
4. Click **Delivered**, **Viewed** or **Clicked**.
5. Read the result: HTTP status, response time, response headers and body, and the exact request as a copyable `curl` command.

**Preview payload** shows the final request before you send it. The timestamp is generated fresh each time.

### What gets sent

SMS Delivered:

```json
[{ "event": "delivered", "data": [{ "ts": 1647441774, "meta": "<msgId>", "description": "Delivered to handset" }] }]
```

WhatsApp Delivered (Viewed is identical with `"status": "read"`):

```json
{ "payloadVersion": "0.1", "statuses": [{ "msgId": "<msgId>", "status": "delivered", "timestamp": "1647441774" }] }
```

Both are sent as `POST` with `Content-Type: application/json`. CleverTap's callback URLs are unique per customer and need no authentication, so no auth header is added.

### Equivalent curl

```bash
curl -X POST 'https://webhook.site/your-id' \
  -H 'Content-Type: application/json' \
  --data-raw '{"payloadVersion":"0.1","statuses":[{"msgId":"25596363|1639561857|20220227|25596363","status":"delivered","timestamp":"1647441774"}]}'
```

## Editing the templates

All payloads live in [`templates.json`](templates.json). Edit the file and the server picks the change up on the next request, with no restart and no code changes. A broken edit is reported as an error in the UI instead of crashing the server.

Structure:

```jsonc
{
  "channels": {
    "sms": {                       // channel key used by the API
      "label": "SMS",              // tab label
      "statuses": {
        "delivered": {             // status key used by the API
          "label": "Delivered",    // button label
          "description": "Tooltip text",
          "request": {
            "method": "POST",
            "headers": { "Content-Type": "application/json" },
            "body": [ /* any JSON object or array */ ]
          }
        }
      }
    }
  }
}
```

Placeholders (replaced inside string values, after the JSON is parsed, so a msgId containing quotes cannot break the payload):

| Placeholder | Becomes |
| --- | --- |
| `{{MSG_ID}}` | The msgId the user entered. Every template must use it. |
| `{{TIMESTAMP}}` | Fresh epoch seconds, as a string (`"1647441774"`) |
| `{{TIMESTAMP:number}}` | Fresh epoch seconds, as a JSON number. Whole-value only. |
| `{{CALLBACK_URL}}` | The callback URL the user entered |

To add a status (for example WhatsApp *Sent* or *Failed*), add another entry under `statuses`. The button appears automatically.

### Where the payloads came from

The templates were built from CleverTap's documentation, not from curl commands. Two details worth checking against your own expectations:

- WhatsApp **Viewed** sends `"status": "read"`, which is CleverTap's name for it.
- WhatsApp **Clicked** sends `"status": "Clicked"` (capital C) with a numeric `ts`, copied from the documented click sample. The docs' field table lists lower-case `clicked` elsewhere, so if CleverTap rejects it, change the value in `templates.json`.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `RATE_LIMIT_PER_MIN` | `30` | Sends per minute per client IP (preview allows 4x this) |
| `REQUEST_TIMEOUT_MS` | `10000` | Total time allowed for DNS, connect and response |
| `MAX_RESPONSE_BYTES` | `65536` | Response body cap shown in the UI |
| `TRUST_PROXY` | off | Set to `true` behind a reverse proxy so the rate limit uses `X-Forwarded-For` |
| `TEMPLATES_PATH` | `./templates.json` | Alternate templates file |
| `ALLOW_HTTP` | off | Developer only: allow `http://` callback URLs |
| `ALLOW_PRIVATE_HOSTS` | off | Developer only: allow localhost and private addresses |

`ALLOW_HTTP` and `ALLOW_PRIVATE_HOSTS` switch off SSRF protection. Use them only on your own machine, for example to test against a local server. Never set them on a shared deployment.

## Security

- **Server-side sending.** Requests go out from the backend, so there are no browser CORS problems.
- **SSRF protection.** Only `https://` URLs are accepted. The hostname is resolved first, and the request is refused if any resulting address is loopback, private, link-local (including cloud metadata at `169.254.169.254`), carrier-grade NAT, multicast, reserved, or an IPv6 equivalent (including IPv4-mapped forms). The connection is then pinned to the address that passed the check, which defeats DNS rebinding. URLs with embedded credentials are rejected.
- **No redirects.** A 3xx response is shown to you; it is never followed.
- **Rate limit.** About 30 sends per minute per IP, kept in memory.
- **Size caps.** API request bodies are capped at 4 KB, outgoing payloads at 16 KB, and displayed responses at 64 KB.
- **10 second timeout** across DNS, connect and response.
- **Browser hardening.** Strict Content-Security-Policy, no inline scripts, all output rendered as text, and cross-origin POSTs are refused.
- **Nothing is stored.** The server logs no URLs, msgIds or responses.

If you expose this beyond your own machine, put it behind your normal access controls. An open "send a POST anywhere" tool is a sensitive thing to host.

## Project layout

```
server.js             HTTP server, routing, security headers
templates.json        Callback payload templates (edit this)
src/templates.js      Loading, validation, placeholder substitution, curl builder
src/validate.js       URL and msgId validation, SSRF checks, DNS resolution
src/http-send.js      Outbound request: pinned address, timeout, size cap, no redirects
src/service.js        Orchestrates validate, build, send
src/ratelimit.js      In-memory sliding-window limiter
public/               Single-page UI (plain HTML, CSS, JS)
test/                 Unit and integration tests
TEST_PLAN.md          Manual test plan
Dockerfile
```

## API

`GET /api/templates`: channels and statuses for the UI.

`POST /api/preview` with `{ "channel", "status", "callbackUrl"?, "msgId"? }`: returns the request that would be sent. Makes no network call.

`POST /api/send` with `{ "channel", "status", "callbackUrl", "msgId" }`: sends the callback. Success returns `{ "result": { "outcome", "durationMs", "request", "response", "note" } }`. Failure returns `{ "error": { "code", "message", "request"? } }`.

Error codes: `INVALID_URL`, `INVALID_MSG_ID`, `BLOCKED_ADDRESS`, `DNS_FAILURE`, `TIMEOUT`, `TLS_ERROR`, `CONNECTION_ERROR`, `UNKNOWN_TEMPLATE`, `TOO_LARGE`, `RATE_LIMITED`, `FORBIDDEN_ORIGIN`, `BAD_REQUEST`.

A non-2xx answer from the callback server is not an API error. It comes back as a normal result with `"outcome": "http_error"` so you can read the response body.
