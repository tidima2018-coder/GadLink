const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ error: "Authentication required" }, { status: 401, headers: corsHeaders });
  }
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!projectUrl || !anonKey) {
    return Response.json({ error: "Supabase Auth is not configured" }, { status: 500, headers: corsHeaders });
  }
  const authResponse = await fetch(`${projectUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization }
  });
  if (!authResponse.ok) {
    return Response.json({ error: "Invalid session" }, { status: 401, headers: corsHeaders });
  }
  const authUser = await authResponse.json();

  const turnUrl = Deno.env.get("TURN_URL");
  const turnSharedSecret = Deno.env.get("TURN_SHARED_SECRET");
  if (!turnUrl || !turnSharedSecret || !authUser?.id) {
    return Response.json({ error: "TURN is not configured" }, { status: 503, headers: corsHeaders });
  }

  const username = `${Math.floor(Date.now() / 1000) + 3600}:${authUser.id}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(turnSharedSecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return Response.json({
    iceServers: [
      { urls: turnUrl.split(",").map((url) => url.trim()).filter(Boolean), username, credential }
    ]
  }, { headers: corsHeaders });
});
