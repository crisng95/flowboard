"""Manual smoke test script for Phase 4.2C: Gemini Browser Driver Real Adapter.

Only runs if environment variable GEMINI_SMOKE_ENABLED=1 is set.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys

# Setup logging to stdout
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("gemini_smoke")

if os.getenv("GEMINI_SMOKE_ENABLED") != "1":
    sys.stderr.write(
        "SKIPPED: Manual Gemini smoke test is disabled.\n"
        "To enable it, make sure you have Chrome running with:\n"
        "  chrome.exe --remote-debugging-port=9222\n"
        "Then set environment variable GEMINI_SMOKE_ENABLED=1 and run:\n"
        "  python -m flowboard.extension_worker.gemini_smoke\n"
    )
    sys.exit(0)


async def main() -> None:
    from flowboard.extension_worker.gemini_browser_driver import GeminiBrowserDriver

    cdp_url = os.getenv("GEMINI_CDP_URL", "http://localhost:9222")
    logger.info("Starting manual Gemini Browser smoke test...")
    driver = GeminiBrowserDriver(
        cdp_url=cdp_url,
        connect_timeout_sec=5.0,
        page_ready_timeout_sec=5.0,
        generation_timeout_sec=20.0,
    )

    test_prompt = "Hello Gemini, please reply with a short sentence saying 'Attached tab smoke test is working!'"
    logger.info("Sending prompt to Gemini via %s...", cdp_url)

    try:
        res = await driver.generate(test_prompt)
        text = res.get("text") or ""
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        logger.info("Test finished successfully!")
        logger.info(
            "Gemini response captured: response_len=%d response_hash=%s",
            len(text),
            text_hash,
        )
        sys.exit(0)
    except Exception as exc:
        logger.error("Test failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
