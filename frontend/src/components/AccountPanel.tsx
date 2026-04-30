import { useEffect, useState } from "react";
import {
  getAuthMe,
  logoutExtension,
  scanExtension,
  type AuthMe,
} from "../api/client";
import { useGenerationStore } from "../store/generation";
import { getLatestRelease, isNewerVersion, type LatestRelease } from "../api/github";
import { SettingsPanel } from "./SettingsPanel";
import packageJson from "../../package.json";

const APP_VERSION: string = packageJson.version;

/**
 * Account chip pinned to the bottom of the project sidebar.
 *
 * Identity (name / email / avatar) flows: extension grabs the Bearer
 * token → calls Google's /oauth2/v2/userinfo → pushes the profile to
 * the agent over WebSocket → we read it from /api/auth/me here.
 *
 * Polled every 5s so the chip backfills automatically once the
 * extension finishes the userinfo round-trip after a fresh sign-in.
 * Stops polling once we have an email — no need to keep hitting it.
 *
 * When the sidebar is collapsed (44px wide), render only the avatar +
 * cog stacked vertically so the chip still fits.
 */
export function AccountPanel({ collapsed = false }: { collapsed?: boolean }) {
  const setStorePaygateTier = useGenerationStore.setState;
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<AuthMe | null>(null);
  // Counts polls that returned a profile but no tier. Used to delay
  // the "Tier unknown" banner so it doesn't flash on initial cold-start
  // while the extension is still doing its first round-trip.
  const [pollsWithoutTier, setPollsWithoutTier] = useState(0);
  // Scan / logout transient state for button affordances.
  const [scanState, setScanState] = useState<"idle" | "scanning" | "no-extension">("idle");
  const [logoutPending, setLogoutPending] = useState(false);
  // Bumped by handleScan / handleLogout to kick the poll effect into
  // re-running immediately instead of waiting for the next 5s tick.
  const [pollNonce, setPollNonce] = useState(0);

  // Poll /api/auth/me until BOTH email and paygate_tier are populated.
  // Email comes from Google's userinfo (fetched once per token rotation
  // by the extension); tier is sniffed from outgoing Flow API request
  // bodies and pushed via WS, which can take a few seconds longer.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const me = await getAuthMe();
      if (!alive) return;
      setProfile(me);
      // Mirror the tier into the generation store so dispatch paths
      // continue to read from a single source. When tier becomes null
      // again (extension disconnect / sign-out), clear the store too —
      // otherwise dispatch would happily reuse a stale tier.
      if (me?.paygate_tier) {
        setStorePaygateTier({ paygateTier: me.paygate_tier });
        setPollsWithoutTier(0);
      } else if (me?.email) {
        // Email present but tier missing — extension connected but
        // hasn't sniffed a Flow request body yet. Count up so the UI
        // knows when to surface the warning banner.
        setStorePaygateTier({ paygateTier: null });
        setPollsWithoutTier((n) => n + 1);
      }
      if (me?.email && me?.paygate_tier) return;
      timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [setStorePaygateTier, pollNonce]);

  // Logout: clears agent-side cache + tells extension to drop in-memory
  // identity. Resets local state immediately so the chip flips to the
  // "Not connected" affordance without waiting for the next poll tick.
  async function handleLogout() {
    if (logoutPending) return;
    setLogoutPending(true);
    try {
      await logoutExtension();
      setProfile({
        email: null,
        name: null,
        picture: null,
        verified_email: null,
        paygate_tier: null,
        sku: null,
        credits: null,
      });
      setStorePaygateTier({ paygateTier: null });
      setPollsWithoutTier(0);
      setPollNonce((n) => n + 1);
    } catch {
      // non-fatal: re-poll will reflect the real state in 5s anyway
    } finally {
      setLogoutPending(false);
    }
  }

  // Scan: probe the extension state and, if a connection is open but
  // userinfo is missing, ask the extension to re-fetch from Google.
  // The poll loop above picks up the new state on the next /me hit.
  async function handleScan() {
    if (scanState === "scanning") return;
    setScanState("scanning");
    try {
      const res = await scanExtension();
      if (!res.extension_connected) {
        setScanState("no-extension");
        // Auto-clear the warning after 8s so the button doesn't get
        // stuck — gives the user time to read it but recovers on its own.
        setTimeout(() => setScanState("idle"), 8000);
        return;
      }
      // Extension is alive — kick the poll loop so the chip refreshes
      // as soon as userinfo lands. The 5s default would feel sluggish
      // right after a deliberate user action.
      setPollNonce((n) => n + 1);
      setScanState("idle");
    } catch {
      setScanState("idle");
    }
  }

  // Surface "new version available" right under the account chip so
  // users notice without having to open Settings. GitHub's release
  // endpoint is cached by the helper (sessionStorage, 1h) so this
  // doesn't burn API quota on every mount.
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);
  useEffect(() => {
    let alive = true;
    getLatestRelease().then((r) => {
      if (alive) setLatestRelease(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  const updateAvailable =
    !!latestRelease?.tagName &&
    isNewerVersion(latestRelease.tagName, APP_VERSION);

  const tier = profile?.paygate_tier ?? null;

  const displayName = profile?.name?.trim() || "Flow account";
  const email = profile?.email ?? null;
  const picture = profile?.picture ?? null;
  const initial = displayName.slice(0, 1).toUpperCase();

  // Google Flow plan tiers — both are paid (Flowboard's hard
  // requirement). TIER_TWO = Ultra (higher tier), TIER_ONE = Pro.
  const tierLabel = tier === "PAYGATE_TIER_TWO"
    ? "Ultra"
    : tier === "PAYGATE_TIER_ONE"
      ? "Pro"
      : "—";

  return (
    <>
      <div
        className={`account-panel${collapsed ? " account-panel--collapsed" : ""}`}
        role="region"
        aria-label="Account"
      >
        <div
          className={`account-panel__avatar${picture ? " account-panel__avatar--photo" : ""}`}
          title={collapsed ? `${displayName} · ${tierLabel}` : undefined}
          aria-hidden="true"
        >
          {picture ? (
            <img
              src={picture}
              alt=""
              referrerPolicy="no-referrer"
              onError={(e) => {
                // Google avatar URL can 403 if the user signed out —
                // hide the broken image and let the initial fallback
                // shine through.
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            initial
          )}
        </div>
        {!collapsed && email && (
          // Connected — show full identity (name + tier + email).
          <div className="account-panel__meta">
            <div className="account-panel__name-row">
              <span className="account-panel__name">{displayName}</span>
              {tier && (
                <span
                  className={`account-panel__tier${
                    tier === "PAYGATE_TIER_TWO"
                      ? " account-panel__tier--ultra"
                      : " account-panel__tier--pro"
                  }`}
                  title={tier}
                >
                  {tierLabel}
                </span>
              )}
            </div>
            <span className="account-panel__email" title={email}>{email}</span>
          </div>
        )}
        {!collapsed && !email && (
          // Disconnected — skip the placeholder "Flow account" / "Connected
          // via extension" copy entirely (clutter without info value), just
          // surface the Scan CTA so the user has one obvious next action.
          <div className="account-panel__meta account-panel__meta--disconnected">
            <button
              type="button"
              className="account-panel__scan-btn"
              onClick={handleScan}
              disabled={scanState === "scanning"}
              title="Scan for an extension connection and re-fetch user info"
            >
              {scanState === "scanning"
                ? "Scanning…"
                : scanState === "no-extension"
                  ? "⚠ Extension not found"
                  : "🔍 Scan extension"}
            </button>
          </div>
        )}
        {email && !collapsed && (
          // Logout sits next to the cog only when an identity is loaded —
          // before login it would be confusing. Icon-only with a tooltip
          // to stay narrow in the sidebar.
          <button
            type="button"
            className="account-panel__logout-btn"
            onClick={handleLogout}
            disabled={logoutPending}
            aria-label="Log out from extension"
            title={logoutPending ? "Logging out…" : "Log out — clear cached identity"}
          >
            ⏻
          </button>
        )}
        <button
          type="button"
          className="account-panel__cog"
          onClick={() => setOpen((v) => !v)}
          aria-label="Open settings"
          title="Settings"
        >
          ⚙
        </button>
      </div>
      {!collapsed && (
        <div className="account-panel__version-row">
          <span className="account-panel__version-label">
            Flowboard <code>v{APP_VERSION}</code>
          </span>
          {updateAvailable && latestRelease && (
            <a
              className="account-panel__update-pill"
              href={latestRelease.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Latest release ${latestRelease.tagName} — click to view`}
            >
              ↑ {latestRelease.tagName}
            </a>
          )}
        </div>
      )}
      {!collapsed && profile?.email && !profile.paygate_tier && pollsWithoutTier >= 2 && (
        // Extension connected (we got the Google profile) but hasn't
        // sniffed a Flow request body yet — tier is unknown. Without
        // this banner, the user would either see an empty tier slot
        // (silently, before v1.1.5) or get a "paygate_tier_unknown"
        // dispatch error with no recovery hint. Surface the gap and
        // give a 1-click path to fix it.
        <div className="account-panel__tier-warning" role="alert">
          <span className="account-panel__tier-warning-icon" aria-hidden="true">⚠</span>
          <div className="account-panel__tier-warning-body">
            <span className="account-panel__tier-warning-title">
              Tier unknown
            </span>
            <span className="account-panel__tier-warning-text">
              Open Flow once so the extension can detect your plan.
            </span>
          </div>
          <a
            className="account-panel__tier-warning-cta"
            href="https://labs.google/fx/tools/flow"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Flow ↗
          </a>
        </div>
      )}
      <SettingsPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
