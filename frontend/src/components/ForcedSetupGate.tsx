import { useEffect, useState } from "react";
import { getLlmConfig } from "../api/client";
import { AiProviderDialog } from "./AiProviderDialog";

/**
 * App-level gate that force-opens the AI Provider dialog whenever the
 * backend reports `configured=false`. The user can't dismiss this
 * dialog — it stays mounted until /config flips to configured (i.e.
 * they ran Apply with all 3 feature tests green).
 *
 * Why an app-level gate (vs putting this on the badge): the backend's
 * dispatch paths now raise loud when no provider is configured. Without
 * a gate, the user's first Generate click would surface a cryptic
 * "no provider configured" toast. Forcing setup at boot makes the
 * happy-path dispatches a guaranteed-success contract.
 *
 * Polling cadence: 30s while visible, plus an immediate refresh on
 * tab-visibility change. Same pattern as AiProviderBadge so they stay
 * in lockstep — when the user Applies inside the dialog, both surfaces
 * see the new state on the next refresh tick.
 */

const POLL_INTERVAL_MS = 30_000;

export function ForcedSetupGate() {
  // null = haven't checked yet (don't render anything to avoid a flash
  // of forced-open dialog before the real state lands).
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const cfg = await getLlmConfig();
        if (!alive) return;
        setConfigured(cfg.configured);
      } catch {
        // Backend hiccup — leave the prior state in place. If the very
        // first call fails we stay at `null` (neutral, no forced
        // dialog) until the next tick succeeds.
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    // Apply inside the dialog dispatches this event so the gate can
    // close immediately instead of waiting up to 30s for the next poll.
    const onConfigChange = () => void refresh();
    window.addEventListener("flowboard:llm-config-changed", onConfigChange);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("flowboard:llm-config-changed", onConfigChange);
    };
  }, []);

  if (configured !== false) return null;

  return (
    <AiProviderDialog
      open
      force
      // onClose is unreachable in force mode (no ✕ / ESC / backdrop),
      // but the prop is required by the dialog's contract — wire it to
      // a no-op so accidental future close paths don't escape the gate.
      onClose={() => {}}
    />
  );
}
