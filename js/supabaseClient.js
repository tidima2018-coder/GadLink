import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = "https://efvnyjvvijbwzaglxpbd.supabase.co";
const supabasePublishableKey = "sb_publishable_W9agBe00b6SuGj_n9a380g_D8Ij8NuK";

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});
