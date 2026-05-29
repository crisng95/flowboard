import React, { useState } from "react";
import { KeyRound, Mail, X, ArrowRight, Loader2, CheckCircle2 } from "lucide-react";
import { hasSupabaseConfig, supabase } from "../cloud/supabase";

interface AuthGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AuthGateModal({ isOpen, onClose, onSuccess }: AuthGateModalProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) {
      setError("Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dev server.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      if (isSignUp) {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (signUpError) throw signUpError;
        setSuccessMsg("Account created! Check your email inbox to confirm, then sign in.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || "An authentication error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/72 backdrop-blur-md transition-opacity duration-300"
        onClick={onClose}
      />
      
      {/* Modal Card */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16161a] p-8 shadow-2xl transition-all duration-300 md:max-w-lg">
        {/* Decorative subtle ambient glows */}
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
        <div className="absolute -right-20 -bottom-20 h-40 w-40 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
        
        {/* Header */}
        <div className="relative flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/14 text-accent border border-accent/20">
              <KeyRound size={20} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white leading-none">
                {isSignUp ? "Create a Cloud Account" : "Sync with Flowboard Cloud"}
              </h2>
              <p className="text-xs text-white/40 mt-1">
                {isSignUp ? "Unlock unlimited storage & remote worker dispatches" : "Access your cloud boards from anywhere"}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-white/50 hover:bg-white/[0.08] hover:text-white transition-all"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Auth Forms */}
        <form onSubmit={handleSubmit} className="relative space-y-4">
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
              {error}
            </div>
          )}

          {successMsg && (
            <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4 text-sm text-green-400 flex items-start gap-2.5">
              <CheckCircle2 className="shrink-0 mt-0.5" size={18} />
              <span>{successMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">Email Address</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-white/30">
                <Mail size={16} />
              </div>
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 pl-10 pr-4 text-sm text-white placeholder-white/20 outline-none focus:border-accent/50 focus:bg-white/[0.04] transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">Password</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-white/30">
                <KeyRound size={16} />
              </div>
              <input
                type="password"
                required
                placeholder="ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 pl-10 pr-4 text-sm text-white placeholder-white/20 outline-none focus:border-accent/50 focus:bg-white/[0.04] transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !hasSupabaseConfig}
            className="w-full rounded-xl bg-accent py-3.5 text-sm font-semibold text-white hover:bg-accent/90 focus:ring-2 focus:ring-accent/50 disabled:opacity-50 transition-all flex items-center justify-center gap-2 mt-6 cursor-pointer shadow-lg shadow-accent/20"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                <span>{isSignUp ? "Get Started" : "Sign In & Sync"}</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        {!hasSupabaseConfig && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
            Missing Supabase config. Sign-in is disabled until <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> are set.
          </div>
        )}

        {/* Footer Toggle */}
        <div className="relative mt-6 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-xs text-white/40">
            {isSignUp ? "Already have a cloud account?" : "New to Flowboard Cloud?"}{" "}
            <button
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError(null);
                setSuccessMsg(null);
              }}
              className="font-semibold text-accent hover:underline focus:outline-none cursor-pointer"
            >
              {isSignUp ? "Sign In" : "Create Account"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
