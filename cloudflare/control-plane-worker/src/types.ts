export type Env = {
  ENVIRONMENT?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  ALLOWED_ORIGINS?: string;
  ASSETS_BUCKET?: R2Bucket;
};

export type Variables = {
  clientId: string;
  clientUserId: string;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};

export type RequestRow = {
  id: string;
  user_id: string;
  provider?: string;
  status?: string;
  claimed_by?: string | null;
  lease_expires_at?: string | null;
  input_data?: Record<string, unknown>;
  output_result?: Record<string, unknown> | null;
};

export type AssetInput = {
  source_provider?: string;
  file_name?: string;
  storage_key?: string;
  mime_type?: string;
  byte_size?: number;
  checksum?: string;
  prompt_snapshot?: string | null;
};

export type WorkerErrorBody = {
  error: string;
  detail?: string;
  request_id?: string;
};
