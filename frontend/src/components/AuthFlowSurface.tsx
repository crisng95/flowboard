import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  Mail,
  KeyRound,
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
  signInWithGoogle,
} from "../cloud/auth";
import { Button } from "../ui/Button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "../ui/card";

interface AuthFlowSurfaceProps {
  mode: AuthFlowMode;
  notice?: string | null;
  onModeChange(mode: AuthFlowMode): void;
  onAuthenticated(): void;
}

export function AuthFlowSurface({
  mode,
  notice: externalNotice = null,
  onModeChange,
  onAuthenticated,
}: AuthFlowSurfaceProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
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

  const actionDisabled = loading || googleLoading || !hasSupabaseConfig;
  const visibleNotice = notice ?? externalNotice;

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

  async function handleGoogleLogin() {
    if (!hasSupabaseConfig) {
      setError(AUTH_CONFIG_ERROR);
      return;
    }
    setGoogleLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(mapAuthError(err, mode));
      setGoogleLoading(false);
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

  const titleText =
    mode === "sign_in"
      ? "Login to your account"
      : mode === "sign_up"
      ? "Create your account"
      : mode === "forgot_password"
      ? "Reset your password"
      : mode === "reset_password"
      ? "Choose a new password"
      : "Confirm your email";

  const descriptionText =
    mode === "sign_in"
      ? "Enter your email below to login to your account"
      : mode === "sign_up"
      ? "Enter your details below to create a new cloud workspace"
      : mode === "forgot_password"
      ? "Enter your email address and we will send a password reset link"
      : mode === "reset_password"
      ? "Set a fresh password to recover access to your account"
      : "Check your inbox and click the confirmation link to proceed";

  return (
    <Card className="w-full bg-[#16161a] border border-white/[0.08] shadow-2xl p-6 md:p-8">
      <CardHeader className="flex flex-row items-start justify-between gap-3 mb-6">
        <div className="flex flex-col min-w-0">
          <CardTitle className="text-xl font-bold text-white leading-none">
            {titleText}
          </CardTitle>
          <CardDescription className="text-xs text-white/45 mt-1.5 max-w-[240px] md:max-w-xs leading-normal">
            {descriptionText}
          </CardDescription>
        </div>
        <CardAction className="flex-shrink-0">
          {mode === "sign_in" ? (
            <Button
              variant="link"
              onClick={() => onModeChange("sign_up")}
              className="text-xs text-accent hover:underline font-semibold p-0 h-auto"
            >
              Sign Up
            </Button>
          ) : (mode === "sign_up" || mode === "forgot_password" || mode === "email_confirmation_pending") ? (
            <Button
              variant="link"
              onClick={() => onModeChange("sign_in")}
              className="text-xs text-accent hover:underline font-semibold p-0 h-auto"
            >
              Sign In
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3.5 text-xs text-red-400">
            {error}
          </div>
        )}

        {visibleNotice && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-3.5 text-xs text-green-400 flex items-start gap-2">
            <CheckCircle2 className="shrink-0 mt-0.5" size={15} />
            <span>{visibleNotice}</span>
          </div>
        )}

        {mode !== "email_confirmation_pending" ? (
          <form onSubmit={handlePrimaryAction} className="space-y-4">
            <div>
              <Label htmlFor="email" className="mb-2 block">Email</Label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-white/30">
                  <Mail size={14} />
                </div>
                <Input
                  id="email"
                  type="email"
                  placeholder="m@example.com"
                  required={mode !== "reset_password"}
                  disabled={mode === "reset_password" || loading || googleLoading}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9 h-10 rounded-xl"
                />
              </div>
            </div>

            {mode !== "forgot_password" && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label htmlFor="password">Password</Label>
                  {mode === "sign_in" && (
                    <Button
                      type="button"
                      variant="link"
                      className="text-xs font-semibold text-accent hover:underline p-0 h-auto"
                      onClick={() => onModeChange("forgot_password")}
                    >
                      Forgot password?
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-white/30">
                    <KeyRound size={14} />
                  </div>
                  <Input
                    id="password"
                    type="password"
                    required
                    disabled={loading || googleLoading}
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 h-10 rounded-xl"
                  />
                </div>
              </div>
            )}

            {mode === "reset_password" && (
              <div>
                <Label htmlFor="confirmPassword" className="mb-2 block">Confirm Password</Label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-white/30">
                    <KeyRound size={14} />
                  </div>
                  <Input
                    id="confirmPassword"
                    type="password"
                    required
                    disabled={loading || googleLoading}
                    placeholder="Repeat the new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-9 h-10 rounded-xl"
                  />
                </div>
                {confirmPassword && confirmPassword !== password && (
                  <p className="mt-1.5 text-xs text-amber-300">Passwords do not match yet.</p>
                )}
              </div>
            )}

            <Button
              type="submit"
              disabled={actionDisabled || !canSubmit}
              className="w-full h-10 rounded-xl font-semibold bg-accent hover:bg-accent/90 transition-all flex items-center justify-center gap-2 mt-4"
            >
              {loading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <>
                  <span>
                    {mode === "sign_in"
                      ? "Login"
                      : mode === "sign_up"
                      ? "Register"
                      : mode === "forgot_password"
                      ? "Send Reset Link"
                      : "Update Password"}
                  </span>
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </form>
        ) : (
          <div className="space-y-3">
            <Button
              type="button"
              disabled={loading || googleLoading || !email.trim() || !hasSupabaseConfig}
              onClick={() => void handleResendConfirmation()}
              className="w-full h-10 rounded-xl font-semibold bg-accent hover:bg-accent/90 transition-all flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
              Resend confirmation email
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full h-10 rounded-xl font-semibold border-white/[0.08] hover:bg-white/[0.04]"
              onClick={() => onModeChange("sign_in")}
            >
              Back to sign in
            </Button>
          </div>
        )}
      </CardContent>

      {mode === "sign_in" && (
        <CardFooter className="flex flex-col gap-2 mt-6 pt-6 border-t border-white/[0.06]">
          <Button
            type="button"
            variant="outline"
            disabled={actionDisabled}
            onClick={() => void handleGoogleLogin()}
            className="w-full h-10 rounded-xl font-semibold border-white/[0.08] hover:bg-white/[0.04] transition-all flex items-center justify-center gap-2"
          >
            {googleLoading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <svg className="h-4 w-4 mr-1" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            Login with Google
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
