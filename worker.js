// Marathon timer — Cloudflare Worker.
// Bindings: KV namespace TIMER_KV (settings), D1 database TIMER_DB (timer).
//
// KV:  config — { settings, internal }  (settings are edited from admin.html)
// D1:  state  — the single timer row that timer.html reads
//      ops    — journal of everything that moved the timer (donation, sub, admin action)
//
// The timer lives in D1 because it is strongly consistent: a webhook's update is visible
// to the next poll from any location and concurrent donations cannot overwrite each other.
// KV takes up to a minute to propagate, which is fine for settings but not for the timer.

// Must match ADMIN_TOKEN in admin.html. A Worker secret named ADMIN_TOKEN overrides it.
const ADMIN_TOKEN = 'change-me';

const DEFAULT_SETTINGS = {
  rates: { monoAmount: 10, monoSeconds: 60, monoMin: 0, tier1: 300, tier2: 600, tier3: 1500 },
  mono: { token: '', account: '' },
  twitch: { clientId: '', clientSecret: '' },
};

const TWITCH_TYPES = ['channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message'];
const TWITCH_SCOPE = 'channel:read:subscriptions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/timer' && method === 'GET') return timerGet(env);
  if (path.startsWith('/hook/mono/')) return monoHook(request, env, path.slice('/hook/mono/'.length));
  if (path === '/hook/twitch' && method === 'POST') return twitchHook(request, env);
  if (path === '/twitch/callback' && method === 'GET') return twitchCallback(url, env);

  if (path.startsWith('/api/')) {
    requireAdmin(request, env);
    const cfg = await ensureConfig(env);
    await ensureSchema(env);
    switch (`${method} ${path}`) {
      case 'GET /api/settings':
        return json(settingsPayload(cfg, url.origin));
      case 'PUT /api/settings':
      case 'POST /api/settings':
        cfg.settings = cleanSettings(await readJson(request));
        await saveConfig(env, cfg);
        return json(settingsPayload(cfg, url.origin));
      case 'GET /api/status':
        return json(await statusPayload(env));
      case 'POST /api/timer':
        return timerAction(await readJson(request), env);
      case 'GET /api/mono/accounts':
        return json(await monoAccounts(cfg, url.origin));
      case 'POST /api/mono/webhook':
        await monoApi(cfg, '/personal/webhook', {
          method: 'POST',
          body: JSON.stringify({ webHookUrl: hookUrls(cfg, url.origin).monoWebhook }),
        });
        return json({ ok: true });
      case 'GET /api/twitch/auth-url':
        return json({ url: await twitchAuthUrl(env, cfg, url.origin) });
      case 'POST /api/twitch/subscribe':
        return json({ subscriptions: await twitchSubscribe(cfg, url.origin) });
      case 'GET /api/twitch/status':
        return json({ channel: cfg.internal.twitch || null, subscriptions: await twitchStatus(cfg, url.origin) });
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------- helpers

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Некоректний JSON');
  }
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(request, env) {
  const token = env.ADMIN_TOKEN || ADMIN_TOKEN;
  if (token === 'change-me') throw new HttpError(503, 'Задайте власний ADMIN_TOKEN у worker.js');
  const header = request.headers.get('Authorization') || '';
  if (!safeEqual(header, `Bearer ${token}`)) throw new HttpError(401, 'Невірний токен адміністратора');
}

function clip(value, max = 60) {
  const s = String(value ?? '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------- config

function cleanSettings(input) {
  const num = (v, fallback, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const r = input?.rates || {};
  const d = DEFAULT_SETTINGS.rates;
  return {
    rates: {
      monoAmount: num(r.monoAmount, d.monoAmount, 0.01),
      monoSeconds: num(r.monoSeconds, d.monoSeconds),
      monoMin: num(r.monoMin, d.monoMin),
      tier1: num(r.tier1, d.tier1),
      tier2: num(r.tier2, d.tier2),
      tier3: num(r.tier3, d.tier3),
    },
    mono: { token: str(input?.mono?.token), account: str(input?.mono?.account) },
    twitch: { clientId: str(input?.twitch?.clientId), clientSecret: str(input?.twitch?.clientSecret) },
  };
}

function loadConfig(env) {
  return env.TIMER_KV.get('config', 'json');
}

function saveConfig(env, cfg) {
  return env.TIMER_KV.put('config', JSON.stringify(cfg));
}

async function ensureConfig(env) {
  let cfg = await loadConfig(env);
  if (!cfg) {
    cfg = {
      settings: cleanSettings(DEFAULT_SETTINGS),
      internal: { monoSecret: randomHex(16), twitchSecret: randomHex(24) },
    };
    await saveConfig(env, cfg);
  }
  return cfg;
}

function hookUrls(cfg, origin) {
  return {
    monoWebhook: `${origin}/hook/mono/${cfg.internal.monoSecret}`,
    twitchCallback: `${origin}/hook/twitch`,
    twitchRedirect: `${origin}/twitch/callback`,
  };
}

function settingsPayload(cfg, origin) {
  return { settings: cfg.settings, info: { ...hookUrls(cfg, origin), twitchChannel: cfg.internal.twitch || null } };
}

// ---------------------------------------------------------------- timer

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     running INTEGER NOT NULL DEFAULT 0,
     ends_at INTEGER NOT NULL DEFAULT 0,
     remaining INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ops (
     id TEXT PRIMARY KEY, t INTEGER NOT NULL, k TEXT NOT NULL, s INTEGER NOT NULL DEFAULT 0,
     src TEXT, note TEXT, applied INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO state (id) VALUES (1)`,
];

function ensureSchema(env) {
  if (!env.TIMER_DB) throw new HttpError(503, 'До воркера не прив’язано базу D1 (binding TIMER_DB)');
  return env.TIMER_DB.batch(SCHEMA.map((sql) => env.TIMER_DB.prepare(sql)));
}

// How each kind of op changes the state row. While running, the timer is `ends_at`;
// while paused it is `remaining` (both in ms).
function stateUpdate(op, now) {
  const ms = op.s * 1000;
  switch (op.k) {
    case 'set':
      return ['remaining = ?, ends_at = ?', [Math.max(0, ms), now + Math.max(0, ms)]];
    case 'add':
      // an expired running timer restarts from the moment of the donation
      return [
        `ends_at = CASE WHEN running = 1 THEN MAX(ends_at, ?) + ? ELSE ends_at END,
         remaining = CASE WHEN running = 1 THEN remaining ELSE MAX(0, remaining + ?) END`,
        [now, ms, ms],
      ];
    case 'pause':
      return ['remaining = CASE WHEN running = 1 THEN MAX(0, ends_at - ?) ELSE remaining END, running = 0', [now]];
    case 'resume':
      return ['ends_at = CASE WHEN running = 0 THEN ? + remaining ELSE ends_at END, running = 1', [now]];
  }
}

// op: { id, t: ms timestamp of the event, k: 'set' | 'add' | 'pause' | 'resume', s: seconds, src, note }
// The batch is one transaction. The op id is the event id, so a webhook retry inserts
// nothing and finds the op already applied: the timer moves exactly once per event.
async function applyOp(env, op) {
  const db = env.TIMER_DB;
  const [assignments, binds] = stateUpdate(op, Date.now());
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO ops (id, t, k, s, src, note) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(op.id, op.t, op.k, op.s, op.src, op.note ?? null),
    db
      .prepare(`UPDATE state SET ${assignments} WHERE id = 1 AND EXISTS (SELECT 1 FROM ops WHERE id = ? AND applied = 0)`)
      .bind(...binds, op.id),
    db.prepare('UPDATE ops SET applied = 1 WHERE id = ?').bind(op.id),
  ]);
}

async function readTimer(env) {
  const row = await env.TIMER_DB.prepare('SELECT running, ends_at, remaining FROM state WHERE id = 1').first();
  return { running: !!row?.running, endsAt: row?.ends_at || 0, remainingMs: row?.remaining || 0, now: Date.now() };
}

async function timerGet(env) {
  try {
    return json(await readTimer(env));
  } catch {
    // tables are created on the first admin request
    return json({ running: false, endsAt: 0, remainingMs: 0, now: Date.now() });
  }
}

async function statusPayload(env) {
  const { results } = await env.TIMER_DB.prepare('SELECT t, k, s, src, note FROM ops ORDER BY rowid DESC LIMIT 50').all();
  return { timer: await readTimer(env), events: results };
}

async function timerAction(body, env) {
  const action = body?.action;
  if (!['set', 'add', 'pause', 'resume'].includes(action)) throw new HttpError(400, 'Невідома дія');
  const seconds = Math.round(Number(body.seconds));
  if ((action === 'set' || action === 'add') && !Number.isFinite(seconds)) throw new HttpError(400, 'Не задано час');

  await applyOp(env, {
    t: Date.now(),
    id: `admin:${Date.now()}:${randomHex(4)}`,
    k: action,
    s: action === 'set' || action === 'add' ? seconds : 0,
    src: 'admin',
  });
  return json(await statusPayload(env));
}

// ---------------------------------------------------------------- monobank

async function monoApi(cfg, path, init = {}) {
  const token = cfg.settings.mono.token;
  if (!token) throw new HttpError(400, 'Не задано токен Monobank');
  const res = await fetch(`https://api.monobank.ua${path}`, {
    ...init,
    headers: { 'X-Token': token, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Monobank: ${data.errorDescription || data.errText || res.status}`);
  return data;
}

const CURRENCY = { 980: 'UAH', 840: 'USD', 978: 'EUR' };

async function monoAccounts(cfg, origin) {
  const info = await monoApi(cfg, '/personal/client-info');
  const currency = (code) => CURRENCY[code] || String(code);
  const jars = (info.jars || []).map((j) => ({ id: j.id, title: `Банка «${j.title}» (${currency(j.currencyCode)})` }));
  const cards = (info.accounts || []).map((a) => ({
    id: a.id,
    title: `Картка ${a.type} ${(a.maskedPan || [])[0] || ''} (${currency(a.currencyCode)})`,
  }));
  return {
    name: info.name,
    webHookUrl: info.webHookUrl || '',
    webhookOk: info.webHookUrl === hookUrls(cfg, origin).monoWebhook,
    accounts: [...jars, ...cards],
  };
}

async function monoHook(request, env, secret) {
  const cfg = await loadConfig(env);
  if (!cfg || !safeEqual(secret, cfg.internal.monoSecret)) return new Response('Not found', { status: 404 });
  // Monobank validates the URL with a GET when the webhook is registered
  if (request.method !== 'POST') return new Response('ok');

  const body = await request.json().catch(() => null);
  const item = body?.data?.statementItem;
  const { rates, mono } = cfg.settings;
  if (body?.type !== 'StatementItem' || !item || !mono.account || body.data.account !== mono.account) {
    return new Response('ok');
  }
  const amount = Number(item.amount) / 100;
  if (!(amount > 0) || amount < rates.monoMin) return new Response('ok');

  const seconds = Math.round((amount / rates.monoAmount) * rates.monoSeconds);
  if (seconds > 0) {
    await applyOp(env, {
      t: Number(item.time) > 0 ? item.time * 1000 : Date.now(),
      id: `mono:${item.id}`,
      k: 'add',
      s: seconds,
      src: 'mono',
      note: clip(`${amount.toFixed(2)} · ${clip(item.description, 40)} ${clip(item.comment, 40)}`, 100),
    });
  }
  return new Response('ok');
}

// ---------------------------------------------------------------- twitch

function twitchCreds(cfg) {
  const tw = cfg.settings.twitch;
  if (!tw.clientId || !tw.clientSecret) throw new HttpError(400, 'Не задано Client ID / Client Secret Twitch');
  return tw;
}

async function twitchToken(tw, params) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: tw.clientId, client_secret: tw.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Twitch OAuth: ${data.message || res.status}`);
  return data.access_token;
}

async function helix(tw, token, path, init = {}) {
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    ...init,
    headers: { 'Client-Id': tw.clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) throw new HttpError(502, `Twitch: ${data.message || res.status}`);
  return data;
}

async function twitchOwnSubs(tw, token, callback) {
  const own = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const res = await helix(tw, token, `/eventsub/subscriptions${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    own.push(...(res.data || []).filter((s) => s.transport?.callback === callback));
    after = res.pagination?.cursor;
    if (!after) break;
  }
  return own;
}

async function twitchAuthUrl(env, cfg, origin) {
  const tw = twitchCreds(cfg);
  cfg.internal.oauth = { state: randomHex(16), exp: Date.now() + 10 * 60_000 };
  await saveConfig(env, cfg);
  const params = new URLSearchParams({
    client_id: tw.clientId,
    redirect_uri: hookUrls(cfg, origin).twitchRedirect,
    response_type: 'code',
    scope: TWITCH_SCOPE,
    state: cfg.internal.oauth.state,
    force_verify: 'true',
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

// The broadcaster grants the app `channel:read:subscriptions` here. The user token itself
// is only needed to learn the channel id: EventSub webhooks are managed with an app token.
async function twitchCallback(url, env) {
  const page = (title, text) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:16px system-ui;max-width:640px;margin:15vh auto;padding:0 16px">` +
        `<h2>${title}</h2><pre style="white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</pre>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  try {
    const cfg = await loadConfig(env);
    const oauth = cfg?.internal.oauth;
    if (!oauth || Date.now() > oauth.exp || !safeEqual(url.searchParams.get('state') || '', oauth.state)) {
      throw new Error('Посилання авторизації застаріло. Почніть ще раз з адмінки.');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error_description') || 'Авторизацію відхилено');

    const tw = twitchCreds(cfg);
    const userToken = await twitchToken(tw, {
      code,
      grant_type: 'authorization_code',
      redirect_uri: hookUrls(cfg, url.origin).twitchRedirect,
    });
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${userToken}` } });
    const who = await res.json();
    if (!res.ok || !who.user_id) throw new Error('Не вдалося визначити канал');

    cfg.internal.twitch = { userId: who.user_id, login: who.login };
    delete cfg.internal.oauth;
    await saveConfig(env, cfg);

    const subs = await twitchSubscribe(cfg, url.origin);
    return page(
      `Канал ${who.login} підключено`,
      subs.map((s) => `${s.type}: ${s.error || s.status}`).join('\n') + '\n\nЦю вкладку можна закрити.',
    );
  } catch (e) {
    return page('Помилка підключення Twitch', e.message || String(e));
  }
}

async function twitchSubscribe(cfg, origin) {
  const tw = twitchCreds(cfg);
  const userId = cfg.internal.twitch?.userId;
  if (!userId) throw new HttpError(400, 'Спочатку авторизуйте канал Twitch');
  const token = await twitchToken(tw, { grant_type: 'client_credentials' });
  const callback = hookUrls(cfg, origin).twitchCallback;

  for (const sub of await twitchOwnSubs(tw, token, callback)) {
    await helix(tw, token, `/eventsub/subscriptions?id=${sub.id}`, { method: 'DELETE' });
  }
  const results = [];
  for (const type of TWITCH_TYPES) {
    try {
      const res = await helix(tw, token, '/eventsub/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          type,
          version: '1',
          condition: { broadcaster_user_id: userId },
          transport: { method: 'webhook', callback, secret: cfg.internal.twitchSecret },
        }),
      });
      results.push({ type, status: res.data?.[0]?.status });
    } catch (e) {
      results.push({ type, error: e.message });
    }
  }
  return results;
}

async function twitchStatus(cfg, origin) {
  const tw = twitchCreds(cfg);
  const token = await twitchToken(tw, { grant_type: 'client_credentials' });
  const subs = await twitchOwnSubs(tw, token, hookUrls(cfg, origin).twitchCallback);
  return subs.map((s) => ({ type: s.type, status: s.status }));
}

async function verifyTwitch(secret, request, body) {
  const id = request.headers.get('Twitch-Eventsub-Message-Id');
  const ts = request.headers.get('Twitch-Eventsub-Message-Timestamp');
  const sig = /^sha256=([0-9a-f]{64})$/i.exec(request.headers.get('Twitch-Eventsub-Message-Signature') || '');
  if (!id || !ts || !sig) return false;
  if (!(Math.abs(Date.now() - Date.parse(ts)) < 10 * 60_000)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(sig[1].match(/../g), (b) => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(id + ts + body));
}

// Returns { seconds, note } for a notification, or null when it must not move the timer.
function twitchReward(type, e, rates) {
  const tier = { 1000: 1, 2000: 2, 3000: 3 }[e.tier];
  if (!tier) return null;
  const perSub = rates[`tier${tier}`];
  switch (type) {
    case 'channel.subscribe':
      // gifted subs are counted once, by channel.subscription.gift
      if (e.is_gift) return null;
      return { seconds: perSub, note: `${e.user_name} · Tier ${tier}` };
    case 'channel.subscription.gift': {
      const total = Math.max(1, Number(e.total) || 1);
      const who = e.is_anonymous ? 'Анонім' : e.user_name;
      return { seconds: perSub * total, note: `${who} · подарунок ${total} × Tier ${tier}` };
    }
    case 'channel.subscription.message':
      // the first month is already reported by channel.subscribe
      if (!(e.cumulative_months > 1)) return null;
      return { seconds: perSub, note: `${e.user_name} · Tier ${tier} · ${e.cumulative_months} міс.` };
  }
  return null;
}

async function twitchHook(request, env) {
  const cfg = await loadConfig(env);
  const body = await request.text();
  if (!cfg || !(await verifyTwitch(cfg.internal.twitchSecret, request, body))) {
    return new Response('Forbidden', { status: 403 });
  }
  const msg = JSON.parse(body);
  const kind = request.headers.get('Twitch-Eventsub-Message-Type');
  if (kind === 'webhook_callback_verification') {
    return new Response(msg.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }
  if (kind === 'notification' && msg.event) {
    const reward = twitchReward(msg.subscription?.type, msg.event, cfg.settings.rates);
    if (reward && reward.seconds > 0) {
      await applyOp(env, {
        t: Math.floor(Date.parse(request.headers.get('Twitch-Eventsub-Message-Timestamp'))),
        id: `twitch:${request.headers.get('Twitch-Eventsub-Message-Id')}`,
        k: 'add',
        s: Math.round(reward.seconds),
        src: 'twitch',
        note: clip(reward.note, 100),
      });
    }
  }
  return new Response(null, { status: 204 });
}
