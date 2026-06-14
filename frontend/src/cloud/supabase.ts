import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// In development, use relative URLs (empty base) so all /api/* requests
// go through localhost:5173 and are forwarded by Vite's dev proxy —
// this avoids CORS entirely. In production, point directly at the API host.
export const cloudApiBaseUrl = import.meta.env.DEV
  ? ""
  : (
      (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ||
      "https://api.flowboard.bond"
    ).replace(/\/+$/, "");

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
