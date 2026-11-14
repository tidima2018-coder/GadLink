import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../js/user-presence.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/, "").replaceAll("export function", "function");

function harness() {
  const channels = [];
  const removed = [];
  const timers = new Map();
  let nextTimer = 0;
  let observed = false;
  const rows = [
    { user_id: "A", show_online_status: true, last_seen_at: "2026-11-14T10:00:00Z" },
    { user_id: "B", show_online_status: true, last_seen_at: "2026-11-14T10:00:00Z" }
  ];
  const classes = new Set();
  const classList = { contains: name => classes.has(name), toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, remove: name => classes.delete(name) };
  let label = null;
  const target = { querySelector: () => label, append: node => { label = node; } };
  const avatar = { dataset: { profileAvatarUserId: "B" }, classList, parentElement: {
    querySelector: () => target
  } };
  const document = Object.assign(new EventTarget(), {
    hidden: false, body: {}, getElementById: () => null,
    querySelectorAll: selector => selector.startsWith("[data-profile") ? [avatar] : [],
    createElement: () => ({ textContent: "", classList: { toggle() {} } })
  });
  const window = new EventTarget();
  const supabase = {
    rpc: async () => ({ error: null }),
    from: () => ({ select: () => ({ in: async () => ({ data: rows.map(row => ({ ...row })), error: null }) }) }),
    channel(name, options) {
      const channel = {
        name, options, handlers: [], tracks: 0, untracks: 0, state: {},
        on(type, filter, callback) { this.handlers.push({ type, filter, callback }); return this; },
        subscribe(callback) { this.status = callback; callback("SUBSCRIBED"); return this; },
        presenceState() { return this.state; },
        async track() { this.tracks += 1; }, async untrack() { this.untracks += 1; },
        emit(type, payload) { for (const handler of this.handlers) if (handler.type === type) handler.callback(payload); }
      };
      channels.push(channel);
      return channel;
    },
    async removeChannel(channel) { removed.push(channel); }
  };
  const context = {
    supabase, document, window, navigator: { onLine: true }, crypto: { randomUUID: () => "device-1" },
    Date, console, Set, Map, CustomEvent,
    MutationObserver: class { observe() { observed = true; } disconnect() { observed = false; } },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { timers.delete(id); }
  };
  const api = vm.runInNewContext(`${source}\n({ formatActivity, createUserPresence });`, context);
  return { ...api, channels, removed, rows, classes, timers, window, context, get observed() { return observed; } };
}

test("activity formatting: unknown, recent, minutes, today, yesterday and older", () => {
  const { formatActivity } = harness();
  const now = new Date(2026, 10, 14, 16, 0);
  assert.equal(formatActivity(null, now), "Не в сети");
  assert.equal(formatActivity(new Date(+now - 4 * 60000), now), "Был недавно");
  assert.equal(formatActivity(new Date(+now - 15 * 60000), now), "Был 15 минут назад");
  assert.match(formatActivity(new Date(2026, 10, 14, 14, 30), now), /сегодня в 14:30/);
  assert.match(formatActivity(new Date(2026, 10, 13, 21, 15), now), /вчера в 21:15/);
  assert.match(formatActivity(new Date(2026, 10, 12, 21, 15), now), /12.11.2026/);
});

test("Presence aggregates devices, hides private activity and cleans up on logout", async () => {
  const h = harness();
  const controller = h.createUserPresence();
  await controller.start("A");
  assert.equal(h.channels.length, 3); // settings, own topic, visible peer
  assert.ok(h.channels.every(channel => channel.options?.config.private));
  const own = h.channels.find(channel => channel.name === "user-presence:A");
  const peer = h.channels.find(channel => channel.name === "user-presence:B");
  assert.equal(own.tracks, 1);
  assert.equal(peer.tracks, 0); // never impersonate the observed user
  await controller.start("A");
  assert.equal(h.channels.length, 3);
  peer.state = { phone: [{}], desktop: [{}] }; peer.emit("presence");
  assert.ok(h.classes.has("is-user-online"));
  peer.state = { desktop: [{}] }; peer.emit("presence");
  assert.ok(h.classes.has("is-user-online"));
  peer.state = {}; peer.emit("presence");
  assert.ok(!h.classes.has("is-user-online"));
  peer.state = { desktop: [{}] }; peer.emit("presence");
  const settings = h.channels.find(channel => channel.name.startsWith("activity-settings-"));
  h.rows[1] = { user_id: "B", show_online_status: false, last_seen_at: null };
  settings.emit("postgres_changes", { new: h.rows[1] });
  assert.ok(!h.classes.has("is-user-online"));
  h.rows[0] = { user_id: "A", show_online_status: false, last_seen_at: null };
  settings.emit("postgres_changes", { new: h.rows[0] });
  assert.equal(own.untracks, 1); // setting changed on another device
  await controller.stop();
  assert.equal(h.removed.length, 3);
  assert.equal(h.timers.size, 0);
  assert.equal(h.observed, false);
  h.window.dispatchEvent(new Event("online"));
  assert.equal(h.timers.size, 0);
});

test("Presence reconnect tracks again without creating a second topic", async () => {
  const h = harness();
  const controller = h.createUserPresence();
  await controller.start("A");
  const own = h.channels.find(channel => channel.name === "user-presence:A");
  own.status("CHANNEL_ERROR");
  own.status("SUBSCRIBED");
  assert.equal(own.tracks, 2);
  assert.equal(h.channels.length, 3);
  await controller.stop();
});

test("logout during Presence startup cannot resurrect subscriptions", async () => {
  const h = harness();
  const controller = h.createUserPresence();
  const starting = controller.start("A");
  await controller.stop();
  await starting;
  assert.equal(h.channels.length, 0);
  assert.equal(h.timers.size, 0);
});

test("recovery coalesces resume events, pauses in background and removes listeners", async () => {
  const recoverySource = (await readFile(new URL("../js/realtime-recovery.js", import.meta.url), "utf8"))
    .replace("export function", "function");
  const h = harness();
  const { createRealtimeRecovery } = vm.runInNewContext(`${recoverySource}\n({ createRealtimeRecovery });`, h.context);
  const recovery = createRealtimeRecovery();
  let syncs = 0;
  h.window.addEventListener("gadlink:resync", () => { syncs += 1; });
  recovery.start(); recovery.start();
  assert.equal(h.timers.size, 1);
  h.window.dispatchEvent(new Event("focus"));
  h.window.dispatchEvent(new Event("online"));
  assert.equal(h.timers.size, 2);
  const [id, callback] = [...h.timers.entries()][1];
  h.timers.delete(id); callback();
  assert.equal(syncs, 1);
  h.context.document.hidden = true;
  h.window.dispatchEvent(new Event("focus"));
  assert.equal(h.timers.size, 1);
  recovery.stop();
  assert.equal(h.timers.size, 0);
  h.context.document.hidden = false;
  h.window.dispatchEvent(new Event("online"));
  assert.equal(h.timers.size, 0);
});
