import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Download, LogOut, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { cloudApiBaseUrl, hasSupabaseConfig, supabase } from "./supabase";
import { AuthFlowSurface } from "../components/AuthFlowSurface";
import {
  isPasswordRecoveryEvent,
  signOutWithCleanup,
  type AuthFlowMode,
} from "./auth";
import { EXTENSION_DOWNLOAD_URL, EXTENSION_INSTALL_NOTE } from "../constants/extension";
import { toast } from "sonner";
import "./cloud-portal.css";

type PairingPayload = {
  controlPlaneBaseUrl: string;
  clientId: string;
  pairingSecret: string;
  mode: "cloud-worker";
};

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let ephemeralInstallationId: string | null = null;

function getInstallationId(): string {
  const key = "flowboard.beta.installationId";
  const value = crypto.randomUUID();

  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    localStorage.setItem(key, value);
    return value;
  } catch {}

  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    sessionStorage.setItem(key, value);
    return value;
  } catch {}

  if (!ephemeralInstallationId) ephemeralInstallationId = value;
  return ephemeralInstallationId;
}

async function postWorker<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${cloudApiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  return data as T;
}

export function CloudPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<AuthFlowMode>("sign_in");
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [prompt, setPrompt] = useState("A luminous crystal flower inside a cinematic cosmic forest");
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const pairingJson = useMemo(() => pairing ? JSON.stringify(pairing, null, 2) : "", [pairing]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (isPasswordRecoveryEvent(event)) setAuthMode("reset_password");
      if (event === "SIGNED_OUT") setAuthMode("sign_in");
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function runAction(action: () => Promise<string | void>, loadingMessage = "Working...") {
    setBusy(true);
    toast.promise(action(), {
      loading: loadingMessage,
      success: (msg) => {
        setBusy(false);
        return msg || "Success!";
      },
      error: (err) => {
        setBusy(false);
        return err instanceof Error ? err.message : String(err);
      }
    });
  }

  if (!hasSupabaseConfig || !supabase) {
    return (
      <main className="cloud-portal">
        <section className="cloud-panel narrow">
          <h1>Flowboard Beta</h1>
          <p>Missing Supabase public config. Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> on Cloudflare Pages.</p>
        </section>
      </main>
    );
  }

  const token = session?.access_token || "";

  return (
    <main className="cloud-portal">
      <section className="cloud-hero">
        <div>
          <p className="eyebrow">Flowboard Cloud Beta</p>
          <h1>Connect your browser worker and run the first Flow job.</h1>
        </div>
        <div className="api-pill"><ShieldCheck size={16} /> {cloudApiBaseUrl}</div>
      </section>

      <section className="cloud-grid">
        <div className="cloud-panel">
          <h2>{session && authMode !== "reset_password" ? "Account" : "Sign in or create account"}</h2>
          {session && authMode !== "reset_password" ? (
            <div className="account-box">
              <div><span>Signed in as</span><strong>{session.user.email}</strong></div>
              <button
                className="secondary"
                onClick={() => runAction(async () => {
                  await signOutWithCleanup();
                  setPairing(null);
                  setLastRequestId(null);
                  return "Signed out successfully.";
                }, "Signing out...")}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          ) : (
            <AuthFlowSurface
              mode={authMode}
              onModeChange={setAuthMode}
              onAuthenticated={() => {
                setAuthMode("sign_in");
                toast.success("Account ready. Pair the extension to continue.");
              }}
            />
          )}
        </div>

        <div className="cloud-panel">
          <h2>Pair Chrome Extension</h2>
          <p className="muted">
            {session
              ? "Step 2: download the Chrome extension ZIP, load it unpacked, then generate a pairing token and paste it into Pair & Connect."
              : "Step 2 starts after sign-in. Create or sign in to your account first."}
          </p>
          <div className="button-row">
            <a className="cloud-link-button secondary" href={EXTENSION_DOWNLOAD_URL} download>
              <Download size={16} /> Download extension
            </a>
            <button disabled={!session || busy} onClick={() => runAction(async () => {
              const secret = randomSecret();
              const result = await postWorker<{ client_id: string }>("/api/pairings/register", token, {
                client_name: navigator.userAgent.includes("Chrome") ? "Chrome Extension" : "Browser Extension",
                client_installation_id: getInstallationId(),
                secret,
              });
              setPairing({ controlPlaneBaseUrl: cloudApiBaseUrl, clientId: result.client_id, pairingSecret: secret, mode: "cloud-worker" });
              return "Pairing token created.";
            }, "Generating pairing token...")}><RefreshCw size={16} /> Generate pairing token</button>
          </div>
          <p className="muted cloud-panel__footnote">{EXTENSION_INSTALL_NOTE}</p>
          {pairing && (
            <div className="token-box">
              <pre>{pairingJson}</pre>
              <button className="secondary" onClick={() => navigator.clipboard.writeText(pairingJson)}><Copy size={16} /> Copy token</button>
            </div>
          )}
        </div>

        <div className="cloud-panel wide">
          <h2>Create real Flow test request</h2>
          <p className="muted">Step 3: after the extension is paired and Google Flow is open, create a queued request here. The extension should claim it and upload the result to R2.</p>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button disabled={!session || busy} onClick={() => runAction(async () => {
            const result = await postWorker<{ request_id: string }>("/api/beta/smoke-request", token, { prompt, provider: "flow", expected_output: "image" });
            setLastRequestId(result.request_id);
            return "Queued request created. Watch the extension status for running/completed.";
          }, "Queueing Flow request...")}><Play size={16} /> Queue Flow request</button>
          {lastRequestId && <div className="request-id"><CheckCircle2 size={16} /> request_id: <code>{lastRequestId}</code></div>}
        </div>
      </section>

      {/* Toast notifications are handled globally by Sonner Toaster */}
    </main>
  );
}
