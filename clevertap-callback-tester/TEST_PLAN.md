# Manual test plan

Run these against a throwaway [webhook.site](https://webhook.site) URL. Open webhook.site in one tab to see requests arrive, and the tester in another.

## Setup

1. `npm start` and open http://localhost:3000.
2. Open https://webhook.site and copy your unique URL (`https://webhook.site/<uuid>`).
3. Use a sample msgId for each channel:
   - SMS: `9999999999.1200000000.1654002362.20220531.0.wzrk_default.-1.`
   - WhatsApp: `25596363|1639561857|20220227|25596363`

For every send below, also check in the tester: HTTP status badge, response time, response headers, response body, the copyable curl command, and a new row in Session history.

## A. Happy path: each channel and button

| # | Channel | Button | Expected request at webhook.site | Expected in tester |
| --- | --- | --- | --- | --- |
| A1 | SMS | Delivered | `POST`, `Content-Type: application/json`, body is an array: `event` = `delivered`, `data[0].meta` = your msgId, `data[0].ts` is a 10-digit **number**, `description` = `Delivered to handset` | Green badge, `HTTP 200 OK` |
| A2 | SMS | Clicked | Array body: `event` = `clicked`, `meta` = your msgId, numeric `ts`, `url` and `shortUrl` present | Green badge |
| A3 | WhatsApp | Delivered | Object body: `payloadVersion` = `"0.1"`, `statuses[0].msgId` = your msgId, `status` = `delivered`, `timestamp` is a 10-digit **string** | Green badge |
| A4 | WhatsApp | Viewed | Same shape, `status` = `read` | Green badge |
| A5 | WhatsApp | Clicked | `statuses[0].status` = `Clicked`, numeric `ts`, `url`, `shortUrl`, `userAgent` | Green badge |

Also verify:

- A6. Click the same button twice. The second request has a **later** timestamp than the first.
- A7. Paste the tester's curl command into a terminal. webhook.site receives an identical request.
- A8. Switching tabs between SMS and WhatsApp changes the buttons (2 vs 3) and the msgId hint text.

## B. Preview payload

- B1. Open **Preview payload** with both fields empty. It shows `MSG_ID_HERE` and `YOUR_CALLBACK_URL`. No request reaches webhook.site.
- B2. Type a msgId. The preview updates within about a second.
- B3. Change the preview status dropdown. The body changes to match.
- B4. Click **Copy curl** and paste it somewhere. It matches the preview.
- B5. The preview matches what arrives at webhook.site when you then click the same button, except for the timestamp.

## C. Input validation (no request should reach webhook.site)

| # | Input | Expected message |
| --- | --- | --- |
| C1 | Empty URL | "Enter the callback URL." and the field is highlighted |
| C2 | `webhook.site/abc` (no scheme) | "not a valid URL. Include https://" |
| C3 | `http://webhook.site/abc` | "must start with https://" |
| C4 | Valid URL, empty msgId | "Enter the msgId you received from CleverTap." |
| C5 | msgId containing only spaces | Same as C4 |
| C6 | msgId `a","status":"x` (quotes) | Sends fine. At webhook.site the JSON is valid and the msgId appears literally inside the string |

## D. Error handling

| # | Setup | Expected |
| --- | --- | --- |
| D1 | URL `https://this-host-does-not-exist.invalid/cb` | Red "DNS lookup failed" |
| D2 | webhook.site: set a custom response status to 500 (Edit URL) | Red badge `HTTP 500`; response body still shown |
| D3 | webhook.site: set status 400 | Red badge `HTTP 400` |
| D4 | webhook.site: set status 302 with a `Location` header | Amber badge, note says the redirect was **not followed**; webhook.site shows only one request |
| D5 | webhook.site: set a response delay above 10s if available, or use `https://httpbin.org/delay/15` | Red "Timed out" after about 10s, with the request curl still shown |
| D6 | `https://expired.badssl.com/` | Red "TLS error" |
| D7 | `https://example.com:81/` (closed port, if it stalls you will see a timeout instead) | Red "Connection failed" or "Timed out" |

## E. Security checks

| # | URL | Expected |
| --- | --- | --- |
| E1 | `https://localhost/cb` | "Address not allowed", nothing sent |
| E2 | `https://127.0.0.1/` | "Address not allowed" |
| E3 | `https://169.254.169.254/latest/meta-data/` | "Address not allowed" |
| E4 | `https://10.0.0.1/` and `https://192.168.1.1/` | "Address not allowed" |
| E5 | `https://[::1]/` | "Address not allowed" |
| E6 | `https://2130706433/` (decimal form of 127.0.0.1) | "Address not allowed" |
| E7 | `https://user:pass@webhook.site/abc` | Rejected: no credentials in URL |
| E8 | `file:///etc/passwd`, `ftp://example.com` | Rejected: must use https |
| E9 | Send 31+ times within a minute | From about the 31st: red "Rate limited" with a retry time. Works again after the minute passes |

## F. UI behaviour

- F1. While a request is in flight (use D5 to slow it down), all status buttons are disabled and the clicked one shows a spinner.
- F2. History shows newest first with channel, status, msgId, response and duration. Click a row: its result reappears above.
- F3. **Clear** empties the history and hides the result panel.
- F4. Reload the page: history is gone (memory only).
- F5. Narrow the window to phone width: layout stays usable, buttons wrap, no horizontal page scroll.
- F6. Dark mode (OS setting): colours remain readable, success and failure still distinct.

## G. Templates

- G1. Edit `templates.json`, for example change SMS delivered `description` text to `Delivered (test)`. Click SMS Delivered again, without restarting. webhook.site shows the new text.
- G2. Add a WhatsApp `sent` status by copying `delivered` and changing `status` to `sent`. Reload the page: a fourth button appears and works.
- G3. Break the JSON (delete a comma). The next send shows a template error instead of crashing. Fix the file and the next send works.

## H. Docker

- H1. `docker build -t clevertap-callback-tester .` succeeds.
- H2. `docker run --rm -p 3000:3000 clevertap-callback-tester`, then repeat A1.
- H3. `docker ps` shows the container as `healthy` after about 30 seconds.
