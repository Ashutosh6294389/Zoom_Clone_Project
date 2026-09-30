import { createClient } from "@supabase/supabase-js";

const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function projectUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const url = configuredUrl ? projectUrl(configuredUrl) : null;

export const supabase = url && publishableKey
  ? createClient(url, publishableKey)
  : null;
