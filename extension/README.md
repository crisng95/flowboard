# Flowboard Bridge (Chrome Extension MV3)

Flowboard Bridge is a Google Chrome extension serving as the core execution worker for Google Flow image and video generation tasks. It leverages the user's active browser session on `labs.google/fx/tools/flow` to generate assets, bypass complex Google UI layers, handle reCAPTCHA Enterprise challenges natively, download secure GCS assets, and upload them back to Flowboard Control Plane.

## Key Features

- **Dual Modes**: Supports both `Cloud Worker` (production cloud deployment) and `Local Bridge` (local FastAPI agent development).
- **Session Capture**: Automatically intercepts active `ya29.*` Bearer credentials from `labs.google`.
- **Captcha Solver**: Passes CAPTCHA Enterprise challenges natively via mainstream-world javascript injection (`injected.js`).
- **Asset Processing**: Validates sizes (up to 25MB), checks whitelisted MIME types (`image/png`, `image/jpeg`, `video/mp4`), calculates Web Crypto SHA-256 hashes, and uploads chunks directly to Cloudflare R2 via presigned URLs.
- **Fail-Safe Loops**: Built-in empty queue backoff, automatic keepalives, and recurring background leases.

## Installation

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** via the toggle in the top-right corner.
3. Click **Load unpacked** in the top-left and select this `./extension` directory.

## Configuration & Usage

Click the extension icon to view the status, check captured token health, review total stats, and manage modes.

### 1. Cloud Worker Mode (Production - Recommended)
- Click the **Gear (⚙)** icon in the header to open settings.
- Select **Cloud Worker (Production)** mode.
- Enter your deployed **Control Plane URL** (e.g., `https://api.yourflowboard.com`).
- Input your unique **Client ID** and **Pairing Secret** generated from your Flowboard Cloud Dashboard.
- Click **Save Config**. The service worker will immediately begin polling the cloud queue and processing generation tasks asynchronously.

### 2. Local Bridge Mode (Development Only)
- Select **Local Bridge (Dev/Staging)** mode in settings.
- The extension will automatically connect to `ws://127.0.0.1:9223` and receive commands from your local running Python agent.

## Unit Testing

A lightweight, robust unit test suite is included in `extension/tests/run_tests.cjs`. It runs natively on Node.js without heavy browser overhead by mocking the browser API layer and Web Crypto APIs.

To execute the legacy runner, run:
```bash
node extension/tests/run_tests.cjs
```
This tests core request routing, client credentials, Flow project IDs, image and video payload structures, magic byte sniffing, size limits, and R2 signed upload flows.

### Vitest suite (property-based + example tests)

The `extension/` package also ships a [vitest](https://vitest.dev/) suite under `extension/test/` that exercises the
real shipped code (loaded into a Node `vm` context with browser shims) and uses
[fast-check](https://fast-check.dev/) for the property-based tests. To run it:
```bash
npm install
npm test
```
