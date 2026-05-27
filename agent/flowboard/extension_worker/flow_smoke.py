"""Manual smoke test script for Phase 4.2I: Flow Browser Driver Scaffold / Real Adapter Prep.

Only runs if environment variable FLOW_SMOKE_ENABLED=1 is set.
Demonstrates browser attachment, minimal tab discovery, ready check, and mock extraction.
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
logger = logging.getLogger("flow_smoke")

if os.getenv("FLOW_SMOKE_ENABLED") != "1":
    sys.stderr.write(
        "SKIPPED: Manual Flow smoke test is disabled.\n"
        "To enable it, make sure you have Chrome running with:\n"
        "  chrome.exe --remote-debugging-port=9222\n"
        "Then set environment variable FLOW_SMOKE_ENABLED=1 and run:\n"
        "  python -m flowboard.extension_worker.flow_smoke\n"
    )
    sys.exit(0)


async def main() -> None:
    from flowboard.extension_worker.flow_browser_driver import FlowBrowserDriver

    cdp_url = os.getenv("FLOW_CDP_URL", "http://localhost:9222")
    logger.info("Starting manual Google Flow Browser smoke test...")
    driver = FlowBrowserDriver(
        cdp_url=cdp_url,
        connect_timeout_sec=5.0,
        page_ready_timeout_sec=5.0,
        generation_timeout_sec=20.0,
    )

    test_prompt = "Hello Flow, this is a minimal attachment smoke test!"
    logger.info("Sending minimal prompt to Flow via %s...", cdp_url)

    try:
        assets = await driver.generate_assets(
            prompt=test_prompt,
            user_id="smoke-user-123",
            request_id="smoke-job-abc"
        )
        
        # Verify mock extraction conforms to the standard visual asset contract
        assert len(assets) == 1
        asset = assets[0]
        assert asset["source_provider"] == "flow"
        assert "content_bytes" in asset
        assert len(asset["content_bytes"]) > 0
        
        checksum_fp = asset["checksum"][:12]
        logger.info("[flow-smoke] Test completed successfully!")
        logger.info(
            "[flow-smoke] Mock visual output extracted: file_name=%s size=%d checksum=%s",
            asset["file_name"],
            asset["byte_size"],
            checksum_fp,
        )
        sys.exit(0)
    except Exception as exc:
        logger.error("[flow-smoke] Test failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
