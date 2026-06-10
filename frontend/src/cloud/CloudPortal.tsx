import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, KeyRound, Loader2, LogOut, Play, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { cloudApiBaseUrl, hasSupabaseConfig, supabase } from "./supabase";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [prompt, setPrompt] = useState("A luminous crystal flower inside a cinematic cosmic forest");
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const pairingJson = useMemo(() => pairing ? JSON.stringify(pairing, null, 2) : "", [pairing]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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

  const supabaseClient = supabase;
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
          <h2>{session ? "Account" : "Sign in or create account"}</h2>
          {session ? (
            <div className="account-box">
              <div><span>Signed in as</span><strong>{session.user.email}</strong></div>
              <button className="secondary" onClick={() => runAction(async () => { await supabaseClient.auth.signOut(); setPairing(null); })}><LogOut size={16} /> Sign out</button>
            </div>
          ) : (
            <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
              <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <div className="button-row">
                <button onClick={() => runAction(async () => {
                  const { error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });
                  if (authError) throw authError;
                })}><KeyRound size={16} /> Sign in</button>
                <button className="secondary" onClick={() => runAction(async () => {
                  const { error: authError } = await supabaseClient.auth.signUp({ email, password });
                  if (authError) throw authError;
                  setMessage("Account created. Check your inbox if email confirmation is enabled, then sign in.");
                })}><UserPlus size={16} /> Sign up</button>
              </div>
            </form>
          )}
        </div>

        <div className="cloud-panel">
          <h2>Pair Chrome Extension</h2>
          <p className="muted">Generate a pairing token, then paste it into the extension Pair & Connect dialog.</p>
          <button disabled={!session || busy} onClick={() => runAction(async () => {
            const secret = randomSecret();
            const result = await postWorker<{ client_id: string }>("/api/pairings/register", token, {
              client_name: navigator.userAgent.includes("Chrome") ? "Chrome Extension" : "Browser Extension",
              client_installation_id: getInstallationId(),
              secret,
            });
            setPairing({ controlPlaneBaseUrl: cloudApiBaseUrl, clientId: result.client_id, pairingSecret: secret, mode: "cloud-worker" });
            setMessage("Pairing token created.");
          })}><RefreshCw size={16} /> Generate pairing token</button>
          {pairing && (
            <div className="token-box">
              <pre>{pairingJson}</pre>
              <button className="secondary" onClick={() => navigator.clipboard.writeText(pairingJson)}><Copy size={16} /> Copy token</button>
            </div>
          )}
        </div>

        <div className="cloud-panel wide">
          <h2>Create real Flow test request</h2>
          <p className="muted">After the extension is paired and Google Flow is open, create a queued request here. The extension should claim it and upload the result to R2.</p>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button disabled={!session || busy} onClick={() => runAction(async () => {
            const result = await postWorker<{ request_id: string }>("/api/beta/smoke-request", token, { prompt, provider: "flow", expected_output: "image" });
            setLastRequestId(result.request_id);
            setMessage("Queued request created. Watch the extension status for running/completed.");
          })}><Play size={16} /> Queue Flow request</button>
          {lastRequestId && <div className="request-id"><CheckCircle2 size={16} /> request_id: <code>{lastRequestId}</code></div>}
        </div>
      </section>

      {(message || error || busy) && (
        <div className={`cloud-toast ${error ? "error" : ""}`}>{busy ? <Loader2 className="spin" size={16} /> : null}{error || message || "Working..."}</div>
      )}
    </main>
  );
}
