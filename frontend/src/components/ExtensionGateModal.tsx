import { useEffect, useState, useMemo } from "react";
import { X, RefreshCw, Copy, Check, Info, ShieldCheck, Loader2, Download } from "lucide-react";
import { supabase, cloudApiBaseUrl } from "../cloud/supabase";
import {
  EXTENSION_DOWNLOAD_URL,
  EXTENSION_INSTALL_NOTE,
  EXTENSION_INSTALL_STEPS,
} from "../constants/extension";

interface ExtensionGateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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

export function ExtensionGateModal({ isOpen, onClose }: ExtensionGateModalProps) {
  const [loading, setLoading] = useState(false);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pairingJson = useMemo(() => (pairing ? JSON.stringify(pairing, null, 2) : ""), [pairing]);

  async function generatePairingToken() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) throw new Error("No active session found. Please sign in again.");

      const token = session.access_token;
      const secret = randomSecret();
      
      const res = await fetch(`${cloudApiBaseUrl}/api/pairings/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          client_name: navigator.userAgent.includes("Chrome") ? "Chrome Extension" : "Browser Extension",
          client_installation_id: getInstallationId(),
          secret,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Failed to register pairing (HTTP ${res.status})`);
      }

      const result = (await res.json()) as { client_id: string };
      setPairing({
        controlPlaneBaseUrl: cloudApiBaseUrl,
        clientId: result.client_id,
        pairingSecret: secret,
        mode: "cloud-worker",
      });
    } catch (err: any) {
      setError(err?.message || "Failed to generate pairing token.");
    } finally {
      setLoading(false);
    }
  }

  // Generate pairing token on first open
  useEffect(() => {
    if (isOpen && !pairing) {
      generatePairingToken();
    }
  }, [isOpen]);

  function handleCopy() {
    if (!pairingJson) return;
    navigator.clipboard.writeText(pairingJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/72 backdrop-blur-md transition-opacity duration-300"
        onClick={onClose}
      />
      
      {/* Modal Card */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16161a] p-8 shadow-2xl transition-all duration-300 md:max-w-lg">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
        
        {/* Header */}
        <div className="relative flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/14 text-accent border border-accent/20">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white leading-none">Connect Extension</h2>
              <p className="text-xs text-white/40 mt-1">Flowboard uses your secure browser session for AI compute</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-white/50 hover:bg-white/[0.08] hover:text-white transition-all"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="relative space-y-4">
          <div className="rounded-xl border border-white/[0.04] bg-white/[0.01] p-4 text-xs text-white/60 space-y-2 leading-relaxed">
            <div className="flex items-center gap-1.5 font-semibold text-white">
              <Info size={14} className="text-accent" />
              <span>How to pair and connect:</span>
            </div>
            <ol className="list-decimal list-inside space-y-1 pl-1">
              {EXTENSION_INSTALL_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="text-[11px] text-white/45">{EXTENSION_INSTALL_NOTE}</p>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider">Pairing Token Block</label>
              <button 
                onClick={generatePairingToken} 
                disabled={loading}
                className="text-xs text-accent hover:underline flex items-center gap-1 bg-transparent border-0 cursor-pointer outline-none"
              >
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
                <span>Re-generate</span>
              </button>
            </div>

            <div className="relative rounded-xl border border-white/[0.08] bg-black/40 p-4 font-mono text-xs text-accent-light/90 overflow-x-auto min-h-[140px] flex items-center">
              {loading ? (
                <div className="w-full flex flex-col items-center justify-center text-white/40 gap-2">
                  <Loader2 size={24} className="animate-spin text-accent" />
                  <span>Registering pairing client...</span>
                </div>
              ) : pairing ? (
                <pre className="text-[11px] leading-tight select-all w-full">{pairingJson}</pre>
              ) : (
                <span className="text-white/20 italic">No token generated yet.</span>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <a
              href={EXTENSION_DOWNLOAD_URL}
              download
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] py-3.5 text-sm font-semibold text-white hover:bg-white/[0.08] transition-all flex items-center justify-center gap-2"
            >
              <Download size={16} />
              <span>Download extension</span>
            </a>

            <button
              onClick={handleCopy}
              disabled={!pairing}
              className="w-full rounded-xl bg-accent py-3.5 text-sm font-semibold text-white hover:bg-accent/90 focus:ring-2 focus:ring-accent/50 disabled:opacity-50 transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-accent/20"
            >
              {copied ? (
                <>
                  <Check size={16} />
                  <span>Copied Token!</span>
                </>
              ) : (
                <>
                  <Copy size={16} />
                  <span>Copy Token</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
