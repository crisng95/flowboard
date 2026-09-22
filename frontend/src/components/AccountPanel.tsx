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
export function AccountPanel({
  collapsed = false,
  onFlowProjectChange,
}: {
  collapsed?: boolean;
  // Fired after Settings re-pins the Flow project. The sidebar reads the
  // pinned id too, so it has to re-read rather than keep showing the value
  // the user just replaced.
  onFlowProjectChange?: () => void;
}) {
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

  // Poll /api/auth/me until there is nothing left to wait for.
  //
  // This used to wait for BOTH email and paygate_tier: email from Google's
  // userinfo, tier from the agent's /v1/credits fetch, both keyed off the
  // Bearer token the extension sniffed. Since Flow moved to flow.google.com
  // no Bearer is minted, so neither ever arrives that way and the old exit
  // condition was unreachable — a /me request every five seconds, forever.
  //
  // The agent now says which of them are actually obtainable, so stop as soon
  // as the remaining gap is not something more polling can close.
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
      } else if (me) {
        // No usable tier. On the current transport that means the agent's
        // FLOWBOARD_PAYGATE_TIER is set to something Flow doesn't recognise
        // (paygate_tier_error says so) — generation will refuse until it is
        // fixed, so clear the store and let the banner surface.
        setStorePaygateTier({ paygateTier: null });
        setPollsWithoutTier((n) => n + 1);
      }
      // Nothing more to learn: either we have the profile, or the agent has
      // told us this transport cannot produce one.
      const identitySettled = !!me?.email || me?.identity_available === false;
      // A misconfigured tier is a config edit away, so keep polling for it.
      const tierSettled = !!me?.paygate_tier;
      if (me && identitySettled && tierSettled) return;
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
        identity_available: false,
        paygate_tier: null,
        paygate_tier_source: "configured",
        paygate_tier_error: null,
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
  const credits = profile?.credits ?? null;
  // Format credits with locale-aware thousand separators so 24340 →
  // "24,340". Tabular-nums in CSS keeps the digits aligned even when
  // the value updates (e.g. after a generation).
  const creditsLabel =
    credits !== null
      ? new Intl.NumberFormat("en-US").format(credits)
      : null;

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
        className={`account-panel${collapsed ? " account-panel--collapsed" : ""}${
          !email ? " account-panel--disconnected" : ""
        }`}
        role="region"
        aria-label="Account"
      >
        {/* Avatar + cog only render when an extension session is live —
            without an email there's no profile to show and the settings
            panel has no actionable controls (logout disabled). */}
        {email && (
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
        )}
        {!collapsed && email && (
          // Connected — three stacked rows: name, email, status (tier
          // + credits). Tier badge moved out of the name row so the
          // name has full width and doesn't ellipsize on narrow
          // sidebars; credits join it in the status row so all the
          // "subscription state" info reads as one unit.
          <div className="account-panel__meta">
            <span className="account-panel__name" title={displayName}>{displayName}</span>
            <span className="account-panel__email" title={email}>{email}</span>
            {(tier || creditsLabel) && (
              <div
                className="account-panel__status-row"
                title={tier ? `${tierLabel}${creditsLabel ? ` · ${creditsLabel} credits remaining` : ""}` : undefined}
              >
                {tier && (
                  <span
                    className={`account-panel__tier${
                      tier === "PAYGATE_TIER_TWO"
                        ? " account-panel__tier--ultra"
                        : " account-panel__tier--pro"
                    }`}
                  >
                    {tierLabel}
                  </span>
                )}
                {creditsLabel && (
                  <span
                    className="account-panel__credits-inline"
                    title={`${creditsLabel} credits remaining`}
                  >
                    <span className="account-panel__credits-value">{creditsLabel}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {!collapsed && !email && (
          // Disconnected — skip the placeholder "Flow account" / "Connected
          // via extension" copy entirely. When the scan probe says no
          // extension is reachable, swap the bare button for a short
          // recovery hint so the user knows the concrete next steps
          // (refresh the Flow tab, reload the extension) instead of
          // bouncing off a generic "not found" warning.
          <div className="account-panel__meta account-panel__meta--disconnected">
            {scanState === "no-extension" ? (
              <div className="account-panel__scan-hint" role="alert">
                <span className="account-panel__scan-hint-title">
                  ⚠ Extension not detected
                </span>
                <span className="account-panel__scan-hint-text">
                  Refresh the Flow tab, then reload the Flowboard extension.
                </span>
                <button
                  type="button"
                  className="account-panel__scan-btn"
                  onClick={handleScan}
                  title="Scan again for an extension connection"
                >
                  Try again
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="account-panel__scan-btn"
                onClick={handleScan}
                disabled={scanState === "scanning"}
                title="Scan for an extension connection and re-fetch user info"
              >
                {scanState === "scanning" ? "Scanning…" : "🔍 Scan extension"}
              </button>
            )}
          </div>
        )}
        {email && (
          <button
            type="button"
            className="account-panel__cog"
            onClick={() => setOpen((v) => !v)}
            aria-label="Open settings"
            title="Settings"
          >
            ⚙
          </button>
        )}
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
      {!collapsed && !profile?.paygate_tier && pollsWithoutTier >= 2 && (
        // No usable tier. This used to mean "the extension has not sniffed a
        // Flow request body yet", and the fix was to open Flow once. Since
        // the migration nothing sniffs anything: the tier is declared in the
        // agent's config, so the only way to land here is a
        // FLOWBOARD_PAYGATE_TIER that Flow does not recognise. Generation
        // will refuse until it is corrected, so say which value is wrong
        // rather than sending the user to open a tab that cannot help.
        <div className="account-panel__tier-warning" role="alert">
          <span className="account-panel__tier-warning-icon" aria-hidden="true">⚠</span>
          <div className="account-panel__tier-warning-body">
            <span className="account-panel__tier-warning-title">
              Plan not configured
            </span>
            <span className="account-panel__tier-warning-text">
              {profile?.paygate_tier_error
                ?? "Set FLOWBOARD_PAYGATE_TIER to PAYGATE_TIER_ONE (Pro) or PAYGATE_TIER_TWO (Ultra)."}
            </span>
          </div>
          <a
            className="account-panel__tier-warning-cta"
            href="https://flow.google.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Flow ↗
          </a>
        </div>
      )}
      <SettingsPanel
        open={open}
        onClose={() => setOpen(false)}
        // Sign out lives in Settings now — only render the action when
        // there's actually a session to drop (no `email` = nothing to
        // sign out from).
        onLogout={email ? async () => {
          await handleLogout();
          setOpen(false);
        } : undefined}
        logoutPending={logoutPending}
        onFlowProjectChange={onFlowProjectChange}
      />
    </>
  );
}
