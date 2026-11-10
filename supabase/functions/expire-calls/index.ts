function constantTimeEqual(first: string, second: string): boolean {
  const left = new TextEncoder().encode(first);
  const right = new TextEncoder().encode(second);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const cronSecret = Deno.env.get("CALL_EXPIRY_CRON_SECRET");
  const supplied = request.headers.get("x-gadlink-cron-secret") || "";
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!cronSecret || !projectUrl || !serviceRoleKey) {
    console.error("GadLink call expiry is missing required secrets.");
    return Response.json({ error: "Call expiry is not configured" }, { status: 503 });
  }
  if (!constantTimeEqual(supplied, cronSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = await fetch(`${projectUrl}/rest/v1/rpc/gadlink_expire_stale_voice_calls`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  if (!response.ok) {
    const body = await response.text();
    console.error("GadLink call expiry RPC failed:", response.status, body);
    return Response.json({ error: "Could not expire stale calls" }, { status: 502 });
  }
  const expired = await response.json();
  return Response.json({ expired: Array.isArray(expired) ? expired.length : 0 });
});
