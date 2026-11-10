import webpush from "npm:web-push@3.6.7";

type JsonRecord = Record<string, unknown>;

const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET");
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT");

function isValidVapidSubject(value: string | undefined): boolean {
  if (!value) return false;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(value)) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function requiredConfiguration(): void {
  if (!projectUrl || !serviceRoleKey || !webhookSecret || !vapidPublicKey || !vapidPrivateKey) {
    throw new Error("Missing required push-dispatch secrets.");
  }
  if (!isValidVapidSubject(vapidSubject)) {
    throw new Error("VAPID_SUBJECT must be set to a valid mailto: contact or HTTPS URL.");
  }
}

function restUrl(path: string): string {
  return `${projectUrl}/rest/v1/${path}`;
}

async function serviceRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(restUrl(path), {
    ...init,
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

async function selectRows(path: string): Promise<JsonRecord[]> {
  const response = await serviceRequest(path);
  return await response.json();
}

async function claimEvent(eventKey: string, userId: string): Promise<string> {
  const response = await serviceRequest("rpc/gadlink_claim_push_event", {
    method: "POST",
    body: JSON.stringify({ target_event_key: eventKey, target_user_id: userId })
  });
  const result = await response.json();
  if (typeof result !== "string" ||
      !["claimed", "complete", "busy", "rate_limited"].includes(result)) {
    throw new Error("Push event claim returned an invalid state.");
  }
  return result;
}

async function updateEvent(eventKey: string, userId: string, action: "complete" | "release", errorMessage?: string): Promise<void> {
  const rpc = action === "complete"
    ? "gadlink_complete_push_event"
    : "gadlink_release_push_event";
  await serviceRequest(`rpc/${rpc}`, {
    method: "POST",
    body: JSON.stringify({
      target_event_key: eventKey,
      target_user_id: userId,
      ...(errorMessage ? { failure_reason: errorMessage.slice(0, 1000) } : {})
    })
  });
}

async function markEndpointDelivered(eventKey: string, userId: string, endpoint: string): Promise<void> {
  await serviceRequest("rpc/gadlink_mark_push_endpoint_delivered", {
    method: "POST",
    body: JSON.stringify({
      target_event_key: eventKey,
      target_user_id: userId,
      target_endpoint: endpoint
    })
  });
}

async function deleteSubscription(endpoint: string): Promise<void> {
  const params = new URLSearchParams({ endpoint: `eq.${endpoint}` });
  await serviceRequest(`push_subscriptions?${params}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

async function profileName(userId: string): Promise<string> {
  const params = new URLSearchParams({ select: "username", id: `eq.${userId}`, limit: "1" });
  const rows = await selectRows(`profiles?${params}`);
  const username = rows[0]?.username;
  return typeof username === "string" && username.trim() ? username.trim() : "Пользователь";
}

async function sendToUser(userId: string, eventKey: string, payload: JsonRecord): Promise<void> {
  const claim = await claimEvent(eventKey, userId);
  if (claim === "complete" || claim === "rate_limited") return;
  if (claim === "busy") throw new Error(`Push event ${eventKey} is already being processed.`);

  try {
    const eventParams = new URLSearchParams({
      select: "delivered_endpoints",
      event_key: `eq.${eventKey}`,
      user_id: `eq.${userId}`,
      limit: "1"
    });
    const [eventRows, subscriptions] = await Promise.all([
      selectRows(`gadlink_push_event_log?${eventParams}`),
      selectRows(`push_subscriptions?${new URLSearchParams({
        select: "endpoint,p256dh,auth,show_preview,active_conversation_id,is_visible,last_seen_at",
        user_id: `eq.${userId}`
      })}`)
    ]);
    const deliveredEndpoints = new Set(
      Array.isArray(eventRows[0]?.delivered_endpoints)
        ? eventRows[0].delivered_endpoints.filter((endpoint): endpoint is string => typeof endpoint === "string")
        : []
    );
    const targets = subscriptions.filter((row) => {
      const lastSeen = typeof row.last_seen_at === "string" ? Date.parse(row.last_seen_at) : 0;
      const visible = row.is_visible === true && Date.now() - lastSeen < 20_000;
      if (!visible) return true;
      if (payload.type !== "message") return false;
      return row.active_conversation_id !== payload.conversationId;
    });

    for (const row of targets) {
      const endpoint = row.endpoint;
      if (typeof endpoint !== "string") {
        console.error("Skipping push subscription with an invalid endpoint", userId);
        continue;
      }
      if (deliveredEndpoints.has(endpoint)) continue;
      if (!allowedPushEndpoint(endpoint) ||
          typeof row.p256dh !== "string" || typeof row.auth !== "string") {
        console.error("Removing malformed or unsupported push subscription", userId);
        await deleteSubscription(endpoint);
        continue;
      }
      try {
        await webpush.sendNotification({
          endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth }
        }, JSON.stringify({
          ...payload,
          recipientId: userId,
          body: row.show_preview === true ? payload.previewBody : payload.body
        }), { TTL: 60, urgency: payload.type === "message" ? "normal" : "high" });
        await markEndpointDelivered(eventKey, userId, endpoint);
        deliveredEndpoints.add(endpoint);
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number })?.statusCode);
        if (statusCode === 404 || statusCode === 410) {
          await deleteSubscription(endpoint);
          continue;
        }
        throw error;
      }
    }
    await updateEvent(eventKey, userId, "complete");
  } catch (error) {
    try {
      await updateEvent(eventKey, userId, "release", error instanceof Error ? error.message : String(error));
    } catch (releaseError) {
      console.error("GadLink could not release failed push event:", releaseError);
    }
    throw error;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

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

function allowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com" ||
      host.endsWith(".fcm.googleapis.com") ||
      host === "push.services.mozilla.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host === "updates.push.services.mozilla.com" ||
      host === "web.push.apple.com" ||
      host.endsWith(".push.apple.com") ||
      host === "notify.windows.com" ||
      host.endsWith(".notify.windows.com");
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    requiredConfiguration();
    const suppliedSecret = request.headers.get("x-gadlink-webhook-secret") || "";
    if (!constantTimeEqual(suppliedSecret, webhookSecret!)) {
      return Response.json({ error: "Unauthorized webhook" }, { status: 401 });
    }
    const event = await request.json() as JsonRecord;
    const table = event.table;
    const eventType = event.type;
    const record = (event.record || event.new_record) as JsonRecord | undefined;
    if (event.schema !== "public" || !record || !isUuid(record.id) ||
        !["messages", "voice_calls"].includes(String(table))) {
      return Response.json({ error: "Unsupported database event" }, { status: 400 });
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey!, vapidPrivateKey!);
    if (table === "messages" && eventType === "INSERT" &&
        isUuid(record.conversation_id) && isUuid(record.user_id)) {
      const params = new URLSearchParams({
        select: "user_id",
        conversation_id: `eq.${record.conversation_id}`,
        user_id: `neq.${record.user_id}`
      });
      const recipients = await selectRows(`conversation_members?${params}`);
      const sender = await profileName(record.user_id);
      const eventKey = `message:${record.id}`;
      const deliveries = await Promise.allSettled(recipients.filter((row) => isUuid(row.user_id)).map((row) => {
        const recipientId = row.user_id as string;
        const body = "Новое сообщение";
        const previewBody = `${sender}: ${String(record.content || "").slice(0, 180)}`;
        return sendToUser(recipientId, `${eventKey}:${recipientId}`, {
          type: "message",
          eventId: eventKey,
          title: sender,
          body,
          previewBody,
          conversationId: record.conversation_id,
          url: "./"
        });
      }));
      const failures = deliveries.filter((delivery) => delivery.status === "rejected");
      if (failures.length) {
        for (const failure of failures) {
          console.error("GadLink message push recipient failed:", failure.reason);
        }
        throw new Error(`${failures.length} message push recipient(s) need retry.`);
      }
      return new Response(null, { status: 204 });
    }

    if (table === "voice_calls" && eventType === "INSERT" && record.status === "ringing" &&
        isUuid(record.caller_id) && isUuid(record.callee_id)) {
      const caller = await profileName(record.caller_id);
      await sendToUser(record.callee_id, `call:${record.id}:ringing`, {
        type: "incoming_call",
        eventId: record.id,
        title: `Входящий звонок от ${caller}`,
        body: "Откройте GadLink, чтобы принять или отклонить звонок.",
        callId: record.id,
        url: "./"
      });
      return new Response(null, { status: 204 });
    }

    if (table === "voice_calls" && eventType === "UPDATE" && record.status === "missed" &&
        isUuid(record.callee_id)) {
      const caller = isUuid(record.caller_id) ? await profileName(record.caller_id) : "Пользователь";
      await sendToUser(record.callee_id, `call:${record.id}:missed`, {
        type: "missed_call",
        eventId: record.id,
        title: "Пропущенный звонок",
        body: `Звонок от ${caller} не был принят.`,
        callId: record.id,
        url: "./"
      });
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("GadLink push-dispatch failed:", error);
    return Response.json({ error: "Push dispatch failed; retry is safe" }, { status: 503 });
  }
});
