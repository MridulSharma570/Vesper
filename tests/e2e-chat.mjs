/**
 * End-to-end test: several online users doing simple text chat.
 *
 * This exercises the exact scenario the product must work for first — multiple
 * concurrent users, connected over WebSocket, exchanging text in real time.
 *
 * Run with:  node e2e-chat.mjs   (server must already be listening on :8787)
 *
 * It asserts behaviour rather than printing raw output, so a regression shows up
 * as a named failure instead of something you have to eyeball.
 */
import { WebSocket } from 'ws';

const BASE = process.env.VESPER_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  const mark = condition ? '  ✓' : '  ✗';
  console.log(`${mark} ${name}${detail && !condition ? `\n      ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/** Create a fully anonymous account: no email, no phone, no provider. */
async function signup(label) {
  const { status, json } = await api('/auth/register', {
    method: 'POST',
    body: {
      method: 'device_key',
      identityKey: `e2e-${label}-${crypto.randomUUID()}`,
      device: { deviceId: `dev-${label}-${Date.now()}`, platform: 'web', appVersion: '1.0.0' },
    },
  });
  if (status !== 201 && status !== 200) throw new Error(`signup ${label} failed: ${status} ${JSON.stringify(json)}`);
  return { label, token: json.accessToken, profile: json.profile };
}

/**
 * Connect a socket and complete the `hello` handshake. Returns helpers to send
 * frames and to wait for a specific server frame.
 */
async function connect(user) {
  const { status, json } = await api('/auth/realtime-ticket', {
    method: 'POST',
    token: user.token,
    body: { deviceId: `dev-${user.label}-ws` },
  });
  if (status !== 200) throw new Error(`ticket failed: ${status} ${JSON.stringify(json)}`);

  const ws = new WebSocket(`${WS_BASE}/realtime?ticket=${encodeURIComponent(json.ticket)}&platform=web`, ['vesper.v1']);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    inbox.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred(frame)) {
        waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket open timeout')), 8000);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });

  const send = (frame) => ws.send(JSON.stringify(frame));

  /** Wait for a frame matching `pred`, or null on timeout. */
  const waitFor = (pred, timeoutMs = 6000) => {
    // Anything already received counts, so we never race the listener.
    const hit = inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  };

  send({ t: 'hello', deviceId: `dev-${user.label}-ws`, platform: 'web', appVersion: '1.0.0' });
  const ready = await waitFor((f) => f.t === 'ready', 8000);
  if (!ready) throw new Error(`no ready frame for ${user.label}`);

  return { ws, send, waitFor, inbox, ready, close: () => ws.close() };
}

/**
 * Establish a mutual contact relationship.
 *
 * Under Vesper's defaults `whoCanMessageMe` and `whoCanAddMeToGroups` are both
 * `contacts`, so a DM or a group invite is refused until the two accounts have
 * accepted each other. That is the correct privacy posture for an anonymous app —
 * a stranger must not be able to open a conversation with you — so the test does
 * the handshake rather than weakening the default to get past it.
 */
async function becomeContacts(a, b) {
  const req = await api('/contacts', { method: 'POST', token: a.token, body: { userId: b.profile.id } });
  if (req.status !== 201 && req.status !== 200) {
    throw new Error(`contact request ${a.label}->${b.label} failed: ${req.status} ${JSON.stringify(req.json)}`);
  }
  // The request id lives on the recipient's pending list.
  const pending = await api('/contacts', { token: b.token });
  const incoming = (pending.json.pending ?? []).find((c) => c.userId === a.profile.id);
  if (!incoming) throw new Error(`no pending request visible to ${b.label}: ${JSON.stringify(pending.json).slice(0, 300)}`);
  const accept = await api('/contacts/respond', {
    method: 'POST', token: b.token, body: { requestId: incoming.id, accept: true },
  });
  if (accept.status !== 200) {
    throw new Error(`accept ${a.label}->${b.label} failed: ${accept.status} ${JSON.stringify(accept.json)}`);
  }
  return true;
}

async function main() {
  console.log(`\nVesper e2e — text chat with multiple online users\n  target: ${BASE}\n`);

  // ── 1. Public surface ────────────────────────────────────────────
  const health = await api('/health');
  check('GET /health reports ok', health.status === 200 && health.json.status === 'ok', JSON.stringify(health.json));

  const ready = await api('/health/ready');
  check('GET /health/ready: database ok', ready.json.checks?.database === 'ok', JSON.stringify(ready.json));
  check('GET /health/ready: storage ok', ready.json.checks?.storage === 'ok', JSON.stringify(ready.json));

  // ── 2. Several anonymous users ───────────────────────────────────
  const alice = await signup('alice');
  const bob = await signup('bob');
  const carol = await signup('carol');
  const dave = await signup('dave');
  const users = [alice, bob, carol, dave];

  check('registered 4 anonymous accounts', users.every((u) => u.token && u.profile?.id));
  check('each account got a distinct generated handle',
    new Set(users.map((u) => u.profile.handle)).size === 4,
    users.map((u) => u.profile.handle).join(', '));
  check('no account leaked an email or phone',
    users.every((u) => !u.profile.email && !u.profile.phone),
    JSON.stringify(alice.profile));
  console.log(`      handles: ${users.map((u) => u.profile.handle).join(', ')}`);

  // ── 3. All four connect over WebSocket simultaneously ────────────
  const sockets = [];
  for (const u of users) sockets.push(await connect(u));
  check('all 4 users connected and received `ready`', sockets.every((s) => s.ready?.userId));
  check('`ready` carries feature flags', !!sockets[0].ready?.features);
  check('text-only flags: media/calls/stories off',
    sockets[0].ready.features.mediaPipeline === false
    && sockets[0].ready.features.calls === false
    && sockets[0].ready.features.stories === false,
    JSON.stringify(sockets[0].ready.features));

  const me = await api('/users/me', { token: alice.token });
  check('GET /users/me returns the caller profile', me.status === 200 && me.json.profile?.id === alice.profile.id);

  // ── 4. Contact handshake, then open a DM ─────────────────────────
  // Everyone becomes contacts with everyone, so the group below can be formed
  // under the default `whoCanAddMeToGroups: 'contacts'` rule.
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) await becomeContacts(users[i], users[j]);
  }
  const contactList = await api('/contacts', { token: alice.token });
  check('contact requests resolve to mutual contacts',
    (contactList.json.contacts ?? []).length === 3,
    `alice has ${(contactList.json.contacts ?? []).length} contacts`);

  const stranger = await signup('stranger');
  const blockedDm = await api(`/users/${stranger.profile.id}/conversation`, { method: 'POST', token: alice.token });
  check('a non-contact cannot be messaged under default privacy settings',
    blockedDm.status === 403 || blockedDm.status === 404, `got ${blockedDm.status}`);

  const dm = await api(`/users/${bob.profile.id}/conversation`, { method: 'POST', token: alice.token });
  check('Alice opened a DM with Bob', dm.status === 201 && !!dm.json.conversation?.id, JSON.stringify(dm.json).slice(0, 200));
  const dmId = dm.json.conversation.id;

  const dm2 = await api(`/users/${bob.profile.id}/conversation`, { method: 'POST', token: alice.token });
  check('opening the same DM twice is idempotent (one conversation, not two)',
    dm2.json.conversation?.id === dmId, `${dmId} vs ${dm2.json.conversation?.id}`);

  // Bob subscribes so he receives the backlog and live frames.
  sockets[1].send({ t: 'conversation.subscribe', conversationId: dmId });
  sockets[0].send({ t: 'conversation.subscribe', conversationId: dmId });
  await new Promise((r) => setTimeout(r, 400));

  // ── 5. Realtime text delivery over the socket ────────────────────
  const cmid = `e2e-${Date.now()}-1`;
  sockets[0].send({
    t: 'message.send',
    clientMessageId: cmid,
    conversationId: dmId,
    kind: 'text',
    body: { text: 'hello bob, this is alice' },
  });

  const ack = await sockets[0].waitFor((f) => f.t === 'message.sent' && f.clientMessageId === cmid);
  check('sender received `message.sent` ack with a server id', !!ack?.message?.id, JSON.stringify(ack));

  const received = await sockets[1].waitFor((f) => f.t === 'message.new' && f.message?.body?.text === 'hello bob, this is alice');
  check('Bob received Alice\'s message in realtime', !!received, JSON.stringify(sockets[1].inbox.slice(-3)));
  check('delivered message carries the sender id', received?.message?.senderId === alice.profile.id);
  check('delivered message id matches the ack', received?.message?.id === ack?.message?.id);

  // ── 6. Reply in the other direction ──────────────────────────────
  const cmid2 = `e2e-${Date.now()}-2`;
  sockets[1].send({
    t: 'message.send', clientMessageId: cmid2, conversationId: dmId, kind: 'text',
    body: { text: 'hi alice, bob here' },
  });
  const back = await sockets[0].waitFor((f) => f.t === 'message.new' && f.message?.body?.text === 'hi alice, bob here');
  check('Alice received Bob\'s reply', !!back);

  // ── 7. Idempotent retry: the same clientMessageId must not duplicate ──
  sockets[0].send({
    t: 'message.send', clientMessageId: cmid, conversationId: dmId, kind: 'text',
    body: { text: 'hello bob, this is alice' },
  });
  const dupeAck = await sockets[0].waitFor((f) => f.t === 'message.sent' && f.clientMessageId === cmid && f.message?.id === ack.message.id, 4000);
  const history = await api(`/conversations/${dmId}/messages`, { token: alice.token });
  const sameText = (history.json.messages ?? []).filter((m) => m.body?.text === 'hello bob, this is alice');
  check('retrying the same clientMessageId does not duplicate the message',
    sameText.length === 1, `found ${sameText.length} copies`);
  void dupeAck;

  // ── 8. HTTP send path also fans out to the socket ────────────────
  const httpMsg = await api('/messages', {
    method: 'POST', token: alice.token,
    body: {
      conversationId: dmId, kind: 'text',
      clientMessageId: `e2e-http-${Date.now()}`,
      body: { text: 'sent over http while socket is open' },
    },
  });
  check('POST /messages succeeded', httpMsg.status === 201 || httpMsg.status === 200, JSON.stringify(httpMsg.json).slice(0, 200));
  const httpReceived = await sockets[1].waitFor((f) => f.t === 'message.new' && f.message?.body?.text === 'sent over http while socket is open');
  check('HTTP-sent message still reached Bob over the socket', !!httpReceived);

  // ── 9. Typing indicator (ephemeral, never stored) ────────────────
  sockets[0].send({ t: 'typing', conversationId: dmId, isTyping: true });
  const typing = await sockets[1].waitFor((f) => f.t === 'typing' && f.isTyping === true);
  check('typing indicator relayed to the other participant', !!typing);

  // ── 10. Read receipt ─────────────────────────────────────────────
  sockets[1].send({ t: 'message.read', conversationId: dmId, messageId: ack.message.id });
  const readFrame = await sockets[0].waitFor((f) => f.t === 'message.read' && f.userId === bob.profile.id);
  check('read receipt relayed back to the sender', !!readFrame);

  // ── 11. Group chat with all four ─────────────────────────────────
  const group = await api('/conversations/groups', {
    method: 'POST', token: alice.token,
    body: { title: 'e2e room', memberIds: [bob.profile.id, carol.profile.id, dave.profile.id] },
  });
  check('Alice created a 4-person group', group.status === 201 && !!group.json.conversation?.id, JSON.stringify(group.json).slice(0, 200));
  const groupId = group.json.conversation?.id;

  for (let i = 1; i < 4; i++) {
    sockets[i].send({ t: 'conversation.subscribe', conversationId: groupId });
  }
  await new Promise((r) => setTimeout(r, 400));

  const gmid = `e2e-group-${Date.now()}`;
  sockets[0].send({ t: 'message.send', clientMessageId: gmid, conversationId: groupId, kind: 'text', body: { text: 'hey everyone' } });

  const fanout = await Promise.all([1, 2, 3].map((i) =>
    sockets[i].waitFor((f) => f.t === 'message.new' && f.message?.body?.text === 'hey everyone', 6000),
  ));
  check('group message fanned out to all 3 other members', fanout.every(Boolean),
    `delivered to ${fanout.filter(Boolean).length}/3`);

  // Each of the other three replies; Alice should see all three.
  for (let i = 1; i < 4; i++) {
    sockets[i].send({
      t: 'message.send', clientMessageId: `e2e-reply-${i}-${Date.now()}`, conversationId: groupId,
      kind: 'text', body: { text: `reply from ${users[i].profile.handle}` },
    });
  }
  const replies = [];
  for (let i = 1; i < 4; i++) {
    const f = await sockets[0].waitFor((fr) => fr.t === 'message.new' && fr.message?.body?.text === `reply from ${users[i].profile.handle}`, 6000);
    if (f) replies.push(f);
  }
  check('Alice received all 3 group replies', replies.length === 3, `got ${replies.length}/3`);

  // ── 12. Presence ─────────────────────────────────────────────────
  // Presence is broadcast on connect and on an explicit `presence.set`. At the
  // moment these sockets said hello, no contact or conversation existed yet, so
  // there was correctly nobody to notify. Now that the group exists, an explicit
  // presence change must reach the other members.
  sockets[1].send({ t: 'presence.set', state: 'online' });
  const presence = await sockets[0].waitFor(
    (f) => f.t === 'presence' && Array.isArray(f.events) && f.events.some((e) => e.userId === bob.profile.id),
    5000,
  );
  check('presence change reaches other conversation members', !!presence,
    `alice saw: ${JSON.stringify(sockets[0].inbox.filter((f) => f.t === 'presence').slice(-2))}`);
  check('presence event carries the user and state',
    presence?.events?.[0]?.userId === bob.profile.id && presence?.events?.[0]?.state === 'online',
    JSON.stringify(presence?.events));

  // Presence must be queryable over HTTP too, for clients that render a list
  // without holding a socket frame for every user.
  const bobView = await api(`/users/${bob.profile.id}`, { token: alice.token });
  check('GET /users/:id includes presence for a contact',
    bobView.status === 200 && !!bobView.json.presence, JSON.stringify(bobView.json).slice(0, 200));

  // ── 13. Authorisation boundaries ─────────────────────────────────
  const noAuth = await api('/users/me');
  check('GET /users/me without a token is 401', noAuth.status === 401, String(noAuth.status));

  const badToken = await api('/users/me', { token: 'not-a-real-token' });
  check('GET /users/me with a bogus token is 401', badToken.status === 401, String(badToken.status));

  // Carol is in the group but NOT in the Alice↔Bob DM.
  const peek = await api(`/conversations/${dmId}/messages`, { token: carol.token });
  check('a non-member cannot read someone else\'s DM', peek.status === 403 || peek.status === 404,
    `got ${peek.status}`);

  const outsiderSocket = await connect(carol);
  outsiderSocket.send({ t: 'conversation.subscribe', conversationId: dmId });
  const denied = await outsiderSocket.waitFor((f) => f.t === 'error', 4000);
  check('subscribing to a conversation you are not in is refused over the socket', !!denied,
    JSON.stringify(outsiderSocket.inbox.slice(-2)));
  outsiderSocket.close();

  // ── 14. Offline delivery: message sent while Dave is disconnected ─
  sockets[3].close();
  await new Promise((r) => setTimeout(r, 600));

  const offlineText = `offline delivery ${Date.now()}`;
  await api('/messages', {
    method: 'POST', token: alice.token,
    body: { conversationId: groupId, kind: 'text', clientMessageId: `e2e-offline-${Date.now()}`, body: { text: offlineText } },
  });
  await new Promise((r) => setTimeout(r, 500));

  // Dave reconnects and must receive what he missed.
  const daveAgain = await connect(dave);
  daveAgain.send({ t: 'conversation.subscribe', conversationId: groupId });
  const replayed = await daveAgain.waitFor((f) => f.t === 'message.new' && f.message?.body?.text === offlineText, 8000);
  check('a message sent while offline is delivered on reconnect', !!replayed,
    JSON.stringify(daveAgain.inbox.slice(0, 6).map((f) => f.t)));

  // ── 15. Refresh-token rotation ───────────────────────────────────
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      method: 'device_key',
      identityKey: `e2e-alice-fixed-key`,
      device: { deviceId: 'dev-refresh-test', platform: 'web', appVersion: '1.0.0' },
    },
  });
  check('sign-in is possible with an existing device key', login.status === 200 || login.status === 201,
    `${login.status} ${JSON.stringify(login.json).slice(0, 160)}`);

  if (login.json.refreshToken) {
    const r1 = await api('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.json.refreshToken, device: { deviceId: 'dev-refresh-test', platform: 'web', appVersion: '1.0.0' } },
    });
    check('refresh token rotates to a new access token', r1.status === 200 && !!r1.json.accessToken, String(r1.status));

    // Reusing the consumed token must be rejected (theft detection).
    const r2 = await api('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.json.refreshToken, device: { deviceId: 'dev-refresh-test', platform: 'web', appVersion: '1.0.0' } },
    });
    check('replaying a consumed refresh token is rejected', r2.status >= 400, `got ${r2.status}`);
  }

  // ── 16. Media pipeline is correctly dark ─────────────────────────
  const policy = await api('/media/policy', { token: alice.token });
  check('media policy reports the pipeline disabled (text-only launch)',
    policy.json.pipelineEnabled === false, JSON.stringify(policy.json).slice(0, 200));

  const callsCfg = await api('/calls/config', { token: alice.token });
  check('calls report disabled (scaffolded, not launched)', callsCfg.json.enabled === false, JSON.stringify(callsCfg.json));

  // ── 17. Concurrency: many messages, all delivered in order ───────
  const N = 25;
  const sent = [];
  for (let i = 0; i < N; i++) {
    const id = `e2e-burst-${i}-${Date.now()}`;
    sockets[0].send({ t: 'message.send', clientMessageId: id, conversationId: dmId, kind: 'text', body: { text: `burst ${i}` } });
    sent.push(id);
  }
  const got = [];
  for (let i = 0; i < N; i++) {
    const f = await sockets[1].waitFor((fr) => fr.t === 'message.new' && fr.message?.body?.text === `burst ${i}` && !got.includes(fr.message.id), 10000);
    if (f) got.push(f.message.id);
  }
  check(`all ${N} burst messages were delivered`, got.length === N, `received ${got.length}/${N}`);
  const sorted = [...got].sort();
  check('burst messages arrived in send order (snowflake ordering holds)',
    JSON.stringify(got) === JSON.stringify(sorted), `first ids: ${got.slice(0, 3).join(' ')}`);

  const finalHistory = await api(`/conversations/${dmId}/messages?limit=200`, { token: alice.token });
  check('history endpoint returns the full transcript',
    (finalHistory.json.messages ?? []).length >= N + 3,
    `got ${(finalHistory.json.messages ?? []).length}`);

  // ── Teardown ─────────────────────────────────────────────────────
  for (const s of sockets) s.close();
  daveAgain.close();
  await new Promise((r) => setTimeout(r, 400));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`\n  Failures:`);
    for (const f of failed) console.log(`   • ${f.name}${f.detail ? `\n     ${f.detail}` : ''}`);
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nFATAL:', e.message, '\n');
  process.exit(2);
});
