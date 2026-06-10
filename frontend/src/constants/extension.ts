export const EXTENSION_VERSION = "0.0.6";

export const EXTENSION_DOWNLOAD_VERSIONED_URL =
  `/downloads/flowboard-extension-v${EXTENSION_VERSION}.zip`;

export const EXTENSION_DOWNLOAD_URL = "/downloads/flowboard-extension-latest.zip";

export const EXTENSION_INSTALL_STEPS = [
  "Download the Flowboard extension ZIP.",
  "Extract the ZIP to a local folder.",
  "Open chrome://extensions.",
  "Turn on Developer mode.",
  "Click Load unpacked and select the extracted folder.",
  "Open the extension popup, then use Pair & Connect.",
] as const;

export const EXTENSION_INSTALL_NOTE =
  "No Chrome Web Store install yet. Use Load unpacked for this beta.";
