// channelBoost.js — engine of the .channelreact command (ported from NEXORA MD).
//
// A user gives THEIR channel link with .channelreact. Immediately, up to 40 OTHER connected sessions follow
// the channel and react to its latest post (40 followers + 40 reactions, 10 different emojis).
// The same round is repeated every day for 5 days and every new post gets up to 40 reactions.
// Then the campaign stops by itself. WhatsApp keeps ONE reaction per account per message, so the 40 reactions
// come from 40 different accounts. If the user is the only one connected, their own account reacts to the
// 10 latest posts instead.
//
// State (campaigns) is saved in the data directory, so it survives a Railway redeploy.
import { dataPath, writeJsonAtomic } from '../utils/paths.js';
import fs from 'fs';

const BOOST_DAYS = 5;
export const BOOST_MS = BOOST_DAYS * 24 * 3600 * 1000;
export const BOOST_SIZE = Number(process.env.BOOST_SIZE) || 40;      // accounts used per round (followers AND reactions)
const REACTS_PER_POST = BOOST_SIZE;                                  // max reactions on one new post
const EMOJI_COUNT = 10;                                              // different emojis per campaign
const MAX_CAMPAIGNS = 30;                                            // channels boosted at the same time
const ROUND_MS = 24 * 3600 * 1000;                                   // one round per day
const BACKFILL_POSTS = 10;
const MAX_POST_AGE_SEC = 10 * 60;                                    // never react to old posts replayed after a restart
const PARALLEL = 6;
const FOLLOW_COOLDOWN_MS = ROUND_MS;                                 // free followers: once a day per user

export const EMOJIS = [...new Set([
    '❤️', '🔥', '👏', '😍', '💯', '🙏', '⚡', '😂', '😎', '🤩',
    '🥰', '😘', '😇', '🤗', '🤭', '😏', '😌', '🤤', '🥳', '🤯',
    '😱', '😭', '🥺', '👑', '💎', '🌟', '✨', '💫', '🌈', '🌸',
    '🌹', '🌻', '🍀', '🎉', '🎊', '🎁', '🎵', '🎧', '🎮', '🏆',
    '🥇', '🚀', '🌍', '💪', '👍', '👌', '✌️', '🤝', '🙌', '👀',
    '🧠', '💡', '💥', '🫶', '🫡', '💜', '💙', '💚', '💛', '🧡',
    '🖤', '🤍', '💖', '💝', '💕', '😹', '🦋', '🦁', '🍾', '🎯',
])];
const BASIC_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const CHANNEL_LINK = /https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[\w-]+/i;
export const inviteCode = (url) => String(url || '').match(/whatsapp\.com\/channel\/([\w-]+)/i)?.[1] || null;
/** A link of ONE post (…/channel/CODE/123) carries the post id: it is used directly. */
export const postHintOf = (text) => String(text || '').match(/whatsapp\.com\/channel\/[\w-]+\/(\d{1,12})/i)?.[1] || null;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
const pickEmojis = () => shuffle(EMOJIS).slice(0, EMOJI_COUNT);
const pause = (min, spread) => new Promise((res) => setTimeout(res, min + Math.floor(Math.random() * spread)));
const sessionId = (socket) => String(socket?.user?.id || 'unknown').split(':')[0].split('@')[0];
const tsOf = (m) => {
    const t = m?.messageTimestamp;
    if (t == null) return 0;
    return typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
};

let lastError = '';
export const lastBoostError = () => lastError;
const noteErr = (where, why) => { lastError = `${where}: ${String(why).slice(0, 90)}`; };

/** Runs fn on the items with at most `limit` at the same time. */
async function eachLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/* ───────── live sessions (registered by utils/connector.js) ───────── */
const live = new Map(); // number -> { socket, isEnabled, given }

export function registerLive(number, socket, isEnabled) {
    loadStateOnce();
    live.set(String(number), { socket, isEnabled, given: live.get(String(number))?.given || 0 });
    startTicker();
}
export function unregisterLive(number, socket) {
    const cur = live.get(String(number));
    // only remove OUR entry: a newer socket of the same account may already be registered
    if (cur && (!socket || cur.socket === socket)) live.delete(String(number));
}
export const liveCount = () => [...live.values()].filter(isOnline).length;

function isOnline(x) {
    try {
        return Boolean(x.socket?.user && !x.socket.ws?.isClosed && !x.socket.ws?.isClosing);
    } catch {
        return false;
    }
}
const enabledOf = (x) => typeof x.isEnabled !== 'function' || x.isEnabled();

/** Other connected accounts (never the owner, never accounts with the reaction OFF), least used first. */
function pickSessions(ownerId, exclude = new Set(), n = BOOST_SIZE) {
    const pool = shuffle([...live.entries()].filter(([sid, x]) => sid !== String(ownerId) && !exclude.has(sid) && isOnline(x) && enabledOf(x)));
    pool.sort((a, b) => a[1].given - b[1].given); // stable: random order among equal counts
    return pool.slice(0, n);
}

/* ───────── campaigns (shared by all sessions of this process) ───────── */
/** ownerId -> { ownerId, jid, name, url, emojis, until, nextRound, followedAt, members, postHint } */
const campaigns = new Map();
const codeByJid = new Map();
const byJid = () => new Map([...campaigns.values()].map((c) => [c.jid, c]));
const stateFile = dataPath('_channelreact.json');
let stateLoaded = false;

function sweep() {
    let changed = false;
    for (const [id, c] of campaigns) if (Date.now() >= c.until) { campaigns.delete(id); changed = true; }
    if (changed) saveState();
}
export const activeCampaigns = () => { sweep(); return [...campaigns.values()]; };
export const campaignOf = (ownerId) => { sweep(); return campaigns.get(String(ownerId)) || null; };
/** Channels this session must follow / stay subscribed to (it is a member of these campaigns). */
export const campaignJidsFor = (number) => activeCampaigns().filter((c) => c.members?.includes(String(number))).map((c) => c.jid);

function loadStateOnce() {
    if (stateLoaded) return;
    stateLoaded = true;
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        for (const c of Array.isArray(raw) ? raw : []) {
            if (typeof c?.jid !== 'string' || !c.jid.endsWith('@newsletter') || !c.ownerId) continue;
            if (c.url && inviteCode(c.url)) codeByJid.set(c.jid, inviteCode(c.url));
            campaigns.set(String(c.ownerId), {
                ownerId: String(c.ownerId),
                jid: c.jid,
                name: String(c.name || '').slice(0, 80),
                url: String(c.url || '').slice(0, 200),
                emojis: Array.isArray(c.emojis) && c.emojis.length === EMOJI_COUNT ? c.emojis.map(String) : pickEmojis(),
                until: Number(c.until) || 0,
                nextRound: Number(c.nextRound) || 0,
                followedAt: Number(c.followedAt) || 0,
                members: Array.isArray(c.members) ? c.members.map(String).slice(0, BOOST_SIZE) : [],
                postHint: c.postHint || null,
            });
        }
        sweep();
    } catch { /* no campaign saved yet */ }
}

let saving = false;
let saveAgain = false;
function saveState() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    try {
        const out = [...campaigns.values()].map(({ busy, ...c }) => c);
        writeJsonAtomic(stateFile, out);
    } catch { /* the campaigns still run in memory */ }
    saving = false;
    if (saveAgain) { saveAgain = false; saveState(); }
}

const refreshers = new Set();
/** Called by the connector: sessions re-subscribe to campaign channels. */
export const onCampaignChange = (fn) => { refreshers.add(fn); return () => refreshers.delete(fn); };
const refreshAll = () => { for (const fn of refreshers) { try { fn(); } catch { /* ignore */ } } };

/* ───────── reactions (ALL / BASIC / NONE channel modes) ───────── */
const modeByJid = new Map(); // jid -> { mode, at }
const findCodes = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    for (const [k, v] of Object.entries(node)) {
        if (/reaction_?codes/i.test(k)) {
            const val = typeof v === 'string' ? v : v?.value ?? v?.code;
            if (typeof val === 'string') return val.toUpperCase();
        }
    }
    for (const v of Object.values(node)) {
        const r = findCodes(v, depth + 1);
        if (r) return r;
    }
    return null;
};
export const reactionModeOf = (jid) => modeByJid.get(jid)?.mode || null;

async function reactionMode(socket, jid) {
    const hit = modeByJid.get(jid);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.mode;
    let mode = null;
    try {
        const meta = await socket.newsletterMetadata?.('jid', jid);
        const m = findCodes(meta);
        if (m && /ALL|BASIC|NONE/.test(m)) mode = m.match(/ALL|BASIC|NONE/)[0];
    } catch (e) {
        noteErr('metadata', e?.message || e);
    }
    modeByJid.set(jid, { mode, at: Date.now() });
    if (modeByJid.size > 200) modeByJid.delete(modeByJid.keys().next().value);
    return mode;
}

/** Reacts with the wanted emoji, or with a basic one when the channel only accepts the basic set. */
async function reactSafe(socket, jid, post, emoji) {
    const mode = await reactionMode(socket, jid);
    if (mode === 'NONE') {
        noteErr('react', 'this channel has reactions turned off');
        throw new Error('reactions are turned off on this channel');
    }
    let use = emoji;
    if (mode === 'BASIC' && !BASIC_EMOJIS.includes(emoji)) use = pick(BASIC_EMOJIS);
    try {
        await socket.newsletterReactMessage(jid, String(post), use);
    } catch (e) {
        if (BASIC_EMOJIS.includes(use)) throw e;
        await socket.newsletterReactMessage(jid, String(post), pick(BASIC_EMOJIS));
    }
}

/* ───────── latest posts of a channel ───────── */
const knownPosts = new Map(); // jid -> [serverId, ...] newest last (seen live)
export function rememberPost(jid, id) {
    if (!id) return;
    const arr = knownPosts.get(jid) || [];
    if (!arr.includes(String(id))) arr.push(String(id));
    while (arr.length > 20) arr.shift();
    knownPosts.set(jid, arr);
    if (knownPosts.size > 100) knownPosts.delete(knownPosts.keys().next().value);
}
export const postIdOf = (message) => message?.key?.server_id || message?.newsletterServerId || message?.newsletter_server_id || message?.server_id;
const fresh = (message) => {
    const ts = tsOf(message);
    return !ts || Date.now() / 1000 - ts <= MAX_POST_AGE_SEC;
};

const collectServerIds = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (node.attrs?.server_id && /^\d+$/.test(String(node.attrs.server_id))) out.push(String(node.attrs.server_id));
    if (Array.isArray(node.content)) for (const c of node.content) collectServerIds(c, out);
    return out;
};

/** Last resort: asks WhatsApp directly (the known query shapes) and reads every server_id of the answer. */
async function rawFetchIds(socket, jid, count) {
    if (typeof socket.query !== 'function') return [];
    const id = () => `kz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const shapes = [
        { to: 's.whatsapp.net', content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(count) } }] },
        ...(codeByJid.get(jid) ? [{ to: 's.whatsapp.net', content: [{ tag: 'messages', attrs: { type: 'invite', key: codeByJid.get(jid), count: String(count) } }] }] : []),
        { to: jid, content: [{ tag: 'message_updates', attrs: { count: String(count) } }] },
        { to: jid, content: [{ tag: 'messages', attrs: { count: String(count) } }] },
    ];
    for (const sh of shapes) {
        try {
            const res = await socket.query({ tag: 'iq', attrs: { id: id(), type: 'get', xmlns: 'newsletter', to: sh.to }, content: sh.content });
            const ids = [...new Set(collectServerIds(res))];
            if (ids.length) return ids;
        } catch (e) {
            noteErr('posts(raw)', e?.message || e);
        }
    }
    return [];
}

/** Latest post ids of a channel. Baileys changed the signature between versions, so every known shape is tried. */
async function latestPostIds(socket, jid, count, log = () => {}) {
    const calls = [];
    if (typeof socket.newsletterFetchMessages === 'function') {
        calls.push(
            () => socket.newsletterFetchMessages(jid, count),
            () => socket.newsletterFetchMessages('jid', jid, count),
            () => socket.newsletterFetchMessages(jid, count, 0),
            () => socket.newsletterFetchMessages(jid, count, Math.floor(Date.now() / 1000) - 60 * 86400),
            () => socket.newsletterFetchMessages(jid, count, 0, 0),
        );
        const code = codeByJid.get(jid);
        if (code) {
            calls.push(
                () => socket.newsletterFetchMessages('invite', code, count),
                () => socket.newsletterFetchMessages('invite', code, count, 0),
            );
        }
    }
    if (typeof socket.newsletterFetchUpdates === 'function') calls.push(() => socket.newsletterFetchUpdates(jid, count));
    const idOf = (x) => x?.server_id ?? x?.serverId ?? x?.key?.server_id ?? x?.newsletterServerId ?? x?.id;
    for (const call of calls) {
        try {
            const raw = await call();
            const list = Array.isArray(raw) ? raw : raw?.messages || raw?.updates || raw?.result || [];
            const ids = [...new Set(list.map(idOf).filter((x) => x != null && /^\d+$/.test(String(x))).map(String))];
            ids.sort((a, b) => Number(b) - Number(a)); // newest first
            if (ids.length) return ids.slice(0, count);
        } catch (e) {
            noteErr('posts', e?.message || e);
            log('warn', 'channel react: fetching latest posts failed', { err: String(e?.message || e).slice(0, 60) });
        }
    }
    const raw = await rawFetchIds(socket, jid, count);
    if (raw.length) return raw.sort((a, b) => Number(b) - Number(a)).slice(0, count);
    const seenLive = (knownPosts.get(jid) || []).slice().reverse().slice(0, count);
    if (seenLive.length) return seenLive;
    noteErr('posts', lastError ? `no post id (${lastError})` : 'WhatsApp returned no post id for this channel');
    return [];
}

/* ───────── campaign: start / first round / daily rounds ───────── */
/**
 * Starts (or replaces) the campaign of `ownerId` on the channel behind `link`.
 * @returns {Promise<{ok:true, campaign:object}|{ok:false, reason:'invalid_link'|'not_found'|'full'}>}
 */
export async function startBoost(sock, link, ownerId, postHint = null) {
    loadStateOnce();
    const id = String(ownerId);
    const code = inviteCode(link);
    if (!code) return { ok: false, reason: 'invalid_link' };
    let meta = null;
    for (let attempt = 0; attempt < 3 && !meta?.id; attempt++) {
        try {
            meta = await sock.newsletterMetadata('invite', code);
            if (meta && !meta.id && meta.jid) meta = { ...meta, id: meta.jid };
        } catch (e) {
            meta = null;
            noteErr('channel lookup', e?.message || e?.data || e);
        }
        if (!meta?.id && attempt < 2) await pause(1500, 100);
    }
    if (!meta?.id || !String(meta.id).endsWith('@newsletter')) {
        if (!lastError.startsWith('channel lookup')) noteErr('channel lookup', 'WhatsApp returned no channel for this link');
        return { ok: false, reason: 'not_found' };
    }
    sweep();
    if (!campaigns.has(id) && campaigns.size >= MAX_CAMPAIGNS) return { ok: false, reason: 'full' };
    const prev = campaigns.get(id);
    const campaign = {
        ownerId: id,
        jid: meta.id,
        name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
        url: `https://whatsapp.com/channel/${code}`,
        emojis: pickEmojis(),
        until: Date.now() + BOOST_MS,
        nextRound: Date.now() + ROUND_MS,
        followedAt: prev?.jid === meta.id ? prev.followedAt || 0 : 0, // same channel again: the daily follower limit still applies
        members: [],
        postHint: postHint && /^\d{1,12}$/.test(String(postHint)) ? String(postHint) : null,
    };
    codeByJid.set(campaign.jid, code);
    campaigns.set(id, campaign); // replaces the previous channel of this user
    saveState();
    refreshAll();
    return { ok: true, campaign: { ...campaign } };
}

export function stopBoost(ownerId) {
    const had = campaigns.delete(String(ownerId));
    if (had) saveState();
    return had;
}

async function followWith(list, jid, log) {
    const ALREADY = /already|exist|conflict|409|subscribed|follow(ing|ed)/i;
    let done = 0;
    await eachLimit(list, PARALLEL, async ([, x]) => {
        await pause(100, 500);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await x.socket.newsletterFollow(jid);
                x.given++;
                done++;
                break;
            } catch (e) {
                const why = String(e?.message || e?.output?.payload?.message || e || '').slice(0, 80);
                if (ALREADY.test(why)) { done++; break; } // that account already follows the channel
                noteErr('follow', why);
                log('warn', 'channel follow failed', { why, attempt });
                if (attempt === 0) await pause(800, 700);
            }
        }
        try { await x.socket.subscribeNewsletterUpdates?.(jid); } catch { /* live updates are optional */ }
    });
    return done;
}

const reactedOn = new Map(); // "jid:postId" -> Set(sessionId) that already reacted
async function reactWith(list, jid, post, emojis, log) {
    const key = `${jid}:${post}`;
    const seen = reactedOn.get(key) || new Set();
    reactedOn.set(key, seen);
    if (reactedOn.size > 300) reactedOn.delete(reactedOn.keys().next().value);
    let sent = 0;
    await eachLimit(list, PARALLEL, async ([sid, x], i) => {
        await pause(100, 500);
        // an account that just followed needs a metadata call before WhatsApp lets it react
        try { await x.socket.newsletterMetadata?.('jid', jid); } catch { /* optional */ }
        try { await x.socket.subscribeNewsletterUpdates?.(jid); } catch { /* optional */ }
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await reactSafe(x.socket, jid, post, emojis[i % emojis.length]);
                seen.add(sid);
                sent++;
                break;
            } catch (e) {
                noteErr('react', e?.message || e);
                log('warn', 'channel react failed', { why: String(e?.message || e || '').slice(0, 80), attempt });
                if (attempt < 2) await pause(1200, 1000);
            }
        }
    });
    return sent;
}

/** This session reacts to the latest posts of a channel (up to 10, one different emoji each). Needs no other session. */
export async function reactLatest(socket, c, log = () => {}) {
    const ids = await latestPostIds(socket, c.jid, BACKFILL_POSTS, log);
    if (c.postHint && !ids.includes(c.postHint)) ids.unshift(c.postHint);
    const offset = Math.floor(Math.random() * c.emojis.length);
    let sent = 0;
    for (const [i, id] of ids.entries()) {
        if (Date.now() >= c.until) break;
        if (i) await pause(1200, 1300);
        try {
            await reactSafe(socket, c.jid, id, c.emojis[(i + offset) % c.emojis.length]);
            sent++;
        } catch (e) {
            log('warn', 'channel react (latest post) failed', { err: String(e?.message || e).slice(0, 60) });
        }
    }
    return { sent, posts: ids.length };
}

/**
 * First round of a campaign: up to 40 other accounts follow the channel (free followers, once a day per user)
 * and react to its latest post. When nobody else is connected, the owner's own account reacts to the 10 latest posts.
 * @returns {Promise<{pool:number, followers:number, followersSkipped:boolean, reacts:number}>}
 */
export async function giveBoost(sock, campaign, log = () => {}) {
    const c = campaigns.get(String(campaign.ownerId)) || campaign;
    const pool = pickSessions(c.ownerId);
    if (!pool.length) {
        try { await sock.newsletterFollow?.(c.jid); } catch { /* already following */ }
        const res = await reactLatest(sock, c, log);
        return { pool: 0, followers: 0, followersSkipped: false, reacts: res.sent };
    }
    c.members = pool.map(([sid]) => sid);
    let followers = 0;
    const followersSkipped = Date.now() - (c.followedAt || 0) < FOLLOW_COOLDOWN_MS;
    if (!followersSkipped) {
        c.followedAt = Date.now();
        followers = await followWith(pool, c.jid, log);
        if (!followers) c.followedAt = 0; // nothing happened: allow a retry
    }
    await pause(2000, 800); // let the follows settle before asking for the posts
    try { await sock.newsletterFollow?.(c.jid); } catch { /* already following */ }
    let ids = c.postHint ? [c.postHint] : await latestPostIds(sock, c.jid, 1, log);
    for (let k = 0; !ids.length && k < Math.min(3, pool.length); k++) ids = await latestPostIds(pool[k][1].socket, c.jid, 1, log);
    const reacts = ids.length ? await reactWith(pool, c.jid, ids[0], c.emojis, log) : 0;
    c.nextRound = Date.now() + ROUND_MS;
    saveState();
    refreshAll(); // members subscribe to the live updates of the channel
    return { pool: pool.length, followers, followersSkipped, reacts };
}

/** Daily round: the members that did not react yet react to the latest post of the channel. */
async function dailyRound(c, log) {
    c.nextRound = Date.now() + ROUND_MS;
    saveState();
    const members = new Set(c.members || []);
    const liveMembers = pickSessions(c.ownerId, new Set(), BOOST_SIZE * 5).filter(([sid]) => members.has(sid));
    if (!liveMembers.length) return;
    const ids = await latestPostIds(liveMembers[0][1].socket, c.jid, 1, log);
    if (!ids.length && c.postHint) ids.push(c.postHint);
    if (!ids.length) return;
    const done = reactedOn.get(`${c.jid}:${ids[0]}`) || new Set();
    const todo = liveMembers.filter(([sid]) => !done.has(sid));
    if (todo.length) await reactWith(todo, c.jid, ids[0], c.emojis, log);
}

let ticker = null;
function startTicker() {
    if (ticker) return;
    ticker = setInterval(async () => {
        sweep();
        for (const c of campaigns.values()) {
            if (!c.nextRound || Date.now() < c.nextRound || c.busy) continue;
            c.busy = true;
            try {
                await dailyRound(c, (lvl, msg, extra) => console.log(`[channelreact:${lvl}] ${msg}`, extra || ''));
            } catch (e) {
                console.log('[channelreact] daily round failed:', String(e?.message || '').slice(0, 60));
            } finally {
                c.busy = false;
            }
        }
    }, 30 * 60 * 1000);
    ticker.unref?.();
}

/* ───────── live posts of a campaign channel ───────── */
const posts = new Map(); // "jid:serverId" -> state
const MAX_TRACKED = 300;

/** A new post arrives on a campaign channel: this session reacts (if it is a member), max 40 per post. */
export function handleCampaignPost(socket, message, jid, isEnabled, log = () => {}) {
    sweep();
    rememberPost(jid, postIdOf(message));
    const c = byJid().get(jid);
    if (!c) return;
    const serverId = postIdOf(message);
    if (!serverId || !fresh(message)) return;
    const key = `${jid}:${serverId}`;
    let st = posts.get(key);
    if (!st) {
        st = { claimed: 0, emojis: shuffle(c.emojis), sessions: new Set() };
        posts.set(key, st);
        if (posts.size > MAX_TRACKED) posts.delete(posts.keys().next().value);
    }
    const me = sessionId(socket);
    if (st.sessions.has(me)) return; // one reaction per session per post
    st.sessions.add(me);
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    if (me === c.ownerId || !c.members?.includes(me) || st.claimed >= REACTS_PER_POST) return; // the owner does not react to their own posts

    const slot = st.claimed++;
    const emoji = st.emojis[slot % st.emojis.length];
    const timer = setTimeout(async () => {
        if (Date.now() >= c.until) return;
        try {
            await reactSafe(socket, jid, serverId, emoji);
            const k = `${jid}:${serverId}`;
            if (!reactedOn.has(k)) reactedOn.set(k, new Set());
            reactedOn.get(k).add(me);
        } catch (e) {
            log('warn', 'channel react failed', { err: String(e?.message || e).slice(0, 60) });
        }
    }, Math.min(slot * 150, 40_000) + Math.floor(Math.random() * 1500));
    timer.unref?.();
}

/** Follow + subscribe to the campaign channels this session belongs to (called by the connector). */
export async function followCampaigns(socket, number) {
    for (const jid of campaignJidsFor(number)) {
        try { await socket.newsletterFollow?.(jid); } catch { /* already following */ }
        try { await socket.subscribeNewsletterUpdates?.(jid); } catch { /* retried later */ }
    }
}

/* ───────── "send the link now" window (after .channelreact without a link) ───────── */
const awaiting = new Map(); // number -> timestamp
export const awaitLink = (number, ms = 3 * 60_000) => awaiting.set(String(number), Date.now() + ms);
export const isAwaitingLink = (number) => (awaiting.get(String(number)) || 0) > Date.now();
export const clearAwaiting = (number) => awaiting.delete(String(number));

export default { startBoost, giveBoost, stopBoost, campaignOf };
