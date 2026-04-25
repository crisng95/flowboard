# Flowboard Bridge (Chrome MV3)

Local extension that proxies Flowboard agent requests to authenticated labs.google sessions.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.

## How it works

- The service worker connects to `ws://127.0.0.1:9222` automatically when the agent is running.
- On first sign-in at `labs.google/fx/tools/flow` the `Authorization: Bearer ya29.*` token is captured automatically from outgoing request headers.
- Responses to agent `api_request` commands are sent via HTTP POST to `http://127.0.0.1:8100/api/ext/callback` with an `X-Callback-Secret` header (secret supplied by the agent on connect). WS fallback is used if HTTP fails.
- A keepalive `ping` is sent every ~24 s; disconnections trigger an automatic reconnect in ~5 s.
- When an `api_request` includes `captchaAction`, the extension solves a reCAPTCHA Enterprise challenge via the injected MAIN-world script (`injected.js`) running on the Flow tab, then patches the token into the request body before forwarding.
- `trpc_request` commands are proxied directly to `https://labs.google/` with the captured Bearer token and browser credentials.

## Content script + injected script

`content.js` runs at `document_start` on `labs.google/fx/tools/flow*` pages. It injects `injected.js` into the MAIN world so it can reach `window.grecaptcha.enterprise`. The two scripts communicate via `CustomEvent` (`GET_CAPTCHA` / `CAPTCHA_RESULT`).

## Popup

Click the extension icon to see connection status, token age, request counters, and buttons to open the Flow tab or force a token refresh.

## Out of scope (this version)

- Side panel
- Agent-side TRPC media URL forwarding listener

See `docs/PLAN.md` for planned additions.
