import type {
  AuthChangeEvent,
  AuthError,
  SignInWithPasswordCredentials,
  SignUpWithPasswordCredentials,
  SupabaseClient,
} from "@supabase/supabase-js";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { useReferencesStore } from "../store/references";
import { supabase } from "./supabase";

export type AuthFlowMode =
  | "sign_in"
  | "sign_up"
  | "forgot_password"
  | "reset_password"
  | "email_confirmation_pending";

export const AUTH_CONFIG_ERROR =
  "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dev server.";

function getSupabaseClient(): SupabaseClient {
  if (!supabase) throw new Error(AUTH_CONFIG_ERROR);
  return supabase;
}

export function authRecoveryRedirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export function authConfirmationRedirectUrl(): string {
  const url = new URL(`${window.location.origin}${window.location.pathname}`);
  url.searchParams.set("auth", "confirmed");
  return url.toString();
}

export function clearAuthDependentState(): void {
  useGenerationStore.setState({ paygateTier: null, projectId: null });
  useBoardStore.setState({
    showAuthModal: false,
    authModalMode: "sign_in",
    showExtensionModal: false,
  });
  useReferencesStore.setState({
    items: [],
    loading: false,
    error: null,
    query: "",
  });
}

export async function signOutWithCleanup(): Promise<void> {
  const client = getSupabaseClient();
  await client.auth.signOut();
  clearAuthDependentState();
}

export async function signInWithPassword(
  credentials: SignInWithPasswordCredentials,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.auth.signInWithPassword(credentials);
  if (error) throw error;
}

export async function signUpWithPassword(
  credentials: SignUpWithPasswordCredentials,
): Promise<void> {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.signUp({
    ...credentials,
    options: {
      ...credentials.options,
      emailRedirectTo: authConfirmationRedirectUrl(),
    },
  });
  if (error) throw error;
  if (data.session) await client.auth.signOut();
}

export async function resendSignupConfirmation(email: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: authConfirmationRedirectUrl(),
    },
  });
  if (error) throw error;
}

export async function sendPasswordResetEmail(email: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: authRecoveryRedirectUrl(),
  });
  if (error) throw error;
}

export async function updatePasswordAfterRecovery(password: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

export function isPasswordRecoveryEvent(event: AuthChangeEvent): boolean {
  return event === "PASSWORD_RECOVERY";
}

export function mapAuthError(error: unknown, mode: AuthFlowMode): string {
  if (!error) return "An authentication error occurred.";
  const message = String((error as AuthError)?.message || error).trim();
  const normalized = message.toLowerCase();

  if (
    normalized.includes("email not confirmed")
    || normalized.includes("email_not_confirmed")
    || normalized.includes("signup_disabled")
  ) {
    return "Your email is not confirmed yet. Check your inbox or resend the confirmation email.";
  }
  if (
    normalized.includes("invalid login credentials")
    || normalized.includes("invalid_credentials")
    || normalized.includes("invalid email or password")
  ) {
    return "Incorrect email or password.";
  }
  if (
    normalized.includes("password should be at least")
    || normalized.includes("weak password")
  ) {
    return "Use a stronger password that meets Supabase minimum requirements.";
  }
  if (
    normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("over_email_send_rate_limit")
  ) {
    return "Too many attempts right now. Wait a moment, then try again.";
  }
  if (
    normalized.includes("same_password")
    || normalized.includes("new password should be different")
  ) {
    return "Choose a new password that is different from the current one.";
  }
  if (mode === "forgot_password") {
    return "Unable to send the reset email right now. Try again in a moment.";
  }
  if (mode === "reset_password") {
    return "Unable to update your password. The recovery link may have expired.";
  }
  if (mode === "sign_up") {
    return "Unable to create your account right now.";
  }
  return "Unable to sign in right now.";
}
