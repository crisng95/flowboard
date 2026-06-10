import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  RotateCcw,
} from "lucide-react";
import { hasSupabaseConfig } from "../cloud/supabase";
import {
  type AuthFlowMode,
  AUTH_CONFIG_ERROR,
  mapAuthError,
  resendSignupConfirmation,
  sendPasswordResetEmail,
  signInWithPassword,
  signUpWithPassword,
  updatePasswordAfterRecovery,
} from "../cloud/auth";

interface AuthFlowSurfaceProps {
  mode: AuthFlowMode;
  layout?: "modal" | "panel";
  onModeChange(mode: AuthFlowMode): void;
  onAuthenticated(): void;
}

const MODE_COPY: Record<
  AuthFlowMode,
  { title: string; subtitle: string; submit?: string }
> = {
  sign_in: {
    title: "Sign in to Flowboard Cloud",
    subtitle: "Sync your spaces and continue cloud workflows across devices.",
    submit: "Sign In",
  },
  sign_up: {
    title: "Create your Flowboard account",
    subtitle: "Create an account, confirm your email, then come back to sync and pair the extension.",
    submit: "Create Account",
  },
  forgot_password: {
    title: "Reset your password",
    subtitle: "We will send a recovery link if the address is eligible for password reset.",
    submit: "Send Reset Link",
  },
  reset_password: {
    title: "Choose a new password",
    subtitle: "Set a fresh password to recover access to your Flowboard account.",
    submit: "Update Password",
  },
  email_confirmation_pending: {
    title: "Confirm your email",
    subtitle: "Check your inbox, confirm the account, then return here to sign in.",
  },
};

export function AuthFlowSurface({
  mode,
  layout = "modal",
  onModeChange,
  onAuthenticated,
}: AuthFlowSurfaceProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setNotice(null);
    if (mode !== "reset_password") {
      setPassword("");
      setConfirmPassword("");
    }
  }, [mode]);

  const copy = MODE_COPY[mode];
  const isPanel = layout === "panel";
  const actionDisabled = loading || !hasSupabaseConfig;
  const iconClassName = isPanel
    ? "flex h-9 w-9 items-center justify-center rounded-lg bg-accent/14 text-accent border border-accent/20"
    : "flex h-10 w-10 items-center justify-center rounded-xl bg-accent/14 text-accent border border-accent/20";

  const primaryLabel = copy.submit ?? "";
  const canSubmit = useMemo(() => {
    if (!hasSupabaseConfig) return false;
    if (mode === "email_confirmation_pending") return false;
    if (mode === "reset_password") return Boolean(password) && password === confirmPassword;
    if (!email.trim()) return false;
    if (mode === "forgot_password") return true;
    if (!password) return false;
    return true;
  }, [confirmPassword, email, mode, password]);

  async function handlePrimaryAction(e: React.FormEvent) {
    e.preventDefault();
    if (!hasSupabaseConfig) {
      setError(AUTH_CONFIG_ERROR);
      return;
    }
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "sign_in") {
        await signInWithPassword({ email, password });
        onAuthenticated();
        return;
      }
      if (mode === "sign_up") {
        await signUpWithPassword({ email, password });
        setNotice("Account created. Check your inbox to confirm your email before signing in.");
        onModeChange("email_confirmation_pending");
        return;
      }
      if (mode === "forgot_password") {
        await sendPasswordResetEmail(email);
        setNotice("If the address is eligible, a password reset email has been sent.");
        return;
      }
      if (mode === "reset_password") {
        await updatePasswordAfterRecovery(password);
        setNotice("Password updated. You are signed in again.");
        onAuthenticated();
      }
    } catch (err) {
      const mapped = mapAuthError(err, mode);
      if (mode === "sign_in" && mapped.toLowerCase().includes("not confirmed")) {
        setNotice(mapped);
        onModeChange("email_confirmation_pending");
      } else {
        setError(mapped);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResendConfirmation() {
    if (!email.trim() || !hasSupabaseConfig) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await resendSignupConfirmation(email);
      setNotice("A new confirmation email has been sent.");
    } catch (err) {
      setError(mapAuthError(err, "email_confirmation_pending"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <div className={`relative flex items-start gap-3 ${isPanel ? "mb-5" : "mb-6"}`}>
        <div className={iconClassName}>
          {mode === "forgot_password" || mode === "reset_password" ? (
            <RotateCcw size={18} />
          ) : (
            <KeyRound size={isPanel ? 18 : 20} />
          )}
        </div>
        <div>
          <h2 className={`${isPanel ? "text-lg" : "text-xl"} font-bold text-white leading-none`}>
            {copy.title}
          </h2>
          <p className={`${isPanel ? "text-sm" : "text-xs"} text-white/45 mt-1.5 max-w-xl`}>
            {copy.subtitle}
          </p>
        </div>
      </div>

      <form onSubmit={handlePrimaryAction} className="relative space-y-4">
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
            {error}
          </div>
        )}

        {notice && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4 text-sm text-green-400 flex items-start gap-2.5">
            <CheckCircle2 className="shrink-0 mt-0.5" size={18} />
            <span>{notice}</span>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
            Email Address
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-white/30">
              <Mail size={16} />
            </div>
            <input
              type="email"
              required={mode !== "reset_password"}
              disabled={mode === "reset_password" || loading}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 pl-10 pr-4 text-sm text-white placeholder-white/20 outline-none focus:border-accent/50 focus:bg-white/[0.04] transition-all disabled:opacity-60"
            />
          </div>
        </div>

        {mode !== "forgot_password" && mode !== "email_confirmation_pending" && (
          <div>
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
              Password
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-white/30">
                <KeyRound size={16} />
              </div>
              <input
                type="password"
                required
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 pl-10 pr-4 text-sm text-white placeholder-white/20 outline-none focus:border-accent/50 focus:bg-white/[0.04] transition-all"
              />
            </div>
          </div>
        )}

        {mode === "reset_password" && (
          <div>
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
              Confirm Password
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-white/30">
                <KeyRound size={16} />
              </div>
              <input
                type="password"
                required
                autoComplete="new-password"
                placeholder="Repeat the new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 pl-10 pr-4 text-sm text-white placeholder-white/20 outline-none focus:border-accent/50 focus:bg-white/[0.04] transition-all"
              />
            </div>
            {confirmPassword && confirmPassword !== password ? (
              <p className="mt-2 text-xs text-amber-300">Passwords do not match yet.</p>
            ) : null}
          </div>
        )}

        {mode === "sign_in" && (
          <div className="flex justify-end">
            <button
              type="button"
              className="text-xs font-semibold text-accent hover:underline"
              onClick={() => onModeChange("forgot_password")}
            >
              Forgot password?
            </button>
          </div>
        )}

        {mode !== "email_confirmation_pending" && (
          <button
            type="submit"
            disabled={actionDisabled || !canSubmit}
            className="w-full rounded-xl bg-accent py-3.5 text-sm font-semibold text-white hover:bg-accent/90 focus:ring-2 focus:ring-accent/50 disabled:opacity-50 transition-all flex items-center justify-center gap-2 mt-2 shadow-lg shadow-accent/20"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                <span>{primaryLabel}</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        )}
      </form>

      {mode === "email_confirmation_pending" && (
        <div className="mt-5 flex flex-col gap-3">
          <button
            type="button"
            disabled={loading || !email.trim() || !hasSupabaseConfig}
            onClick={() => void handleResendConfirmation()}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg shadow-accent/20"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
            Resend confirmation email
          </button>
          <button
            type="button"
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 text-sm font-semibold text-white/80 hover:bg-white/[0.06] transition-all"
            onClick={() => onModeChange("sign_in")}
          >
            Back to sign in
          </button>
        </div>
      )}

      {!hasSupabaseConfig && (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
          Sign-in is disabled until <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> are set.
        </div>
      )}

      <div className={`relative ${isPanel ? "mt-5 pt-5" : "mt-6 pt-6"} border-t border-white/[0.06] text-center`}>
        {mode === "sign_in" ? (
          <p className="text-xs text-white/40">
            New to Flowboard Cloud?{" "}
            <button
              type="button"
              className="font-semibold text-accent hover:underline focus:outline-none"
              onClick={() => onModeChange("sign_up")}
            >
              Create Account
            </button>
          </p>
        ) : mode === "sign_up" ? (
          <p className="text-xs text-white/40">
            Already have an account?{" "}
            <button
              type="button"
              className="font-semibold text-accent hover:underline focus:outline-none"
              onClick={() => onModeChange("sign_in")}
            >
              Sign In
            </button>
          </p>
        ) : mode === "forgot_password" ? (
          <p className="text-xs text-white/40">
            Remembered it?{" "}
            <button
              type="button"
              className="font-semibold text-accent hover:underline focus:outline-none"
              onClick={() => onModeChange("sign_in")}
            >
              Back to sign in
            </button>
          </p>
        ) : mode === "reset_password" ? (
          <p className="text-xs text-white/40">
            Need a fresh recovery link?{" "}
            <button
              type="button"
              className="font-semibold text-accent hover:underline focus:outline-none"
              onClick={() => onModeChange("forgot_password")}
            >
              Send another reset email
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
