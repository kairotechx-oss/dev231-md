import { attachExtraEvents } from '../commands/more.js';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import fs from 'fs';
import { autoJoinAll } from './autoJoin.js';
import { WA_CHANNEL_IDS } from './channelConfig.js';
import configManager from './manageConfigs.js';
import welcomeModule from '../commands/welcomeModule.js';
import { registerLive, unregisterLive, followCampaigns, campaignJidsFor, onCampaignChange } from '../commands/channelBoost.js';
import { DATA_DIR, writeJsonAtomic } from './paths.js';
import { initSessionBackup, scheduleBackup, deleteBackup, restoreFromBackup, backupAll, startBackupLoop } from './sessionBackup.js';

// On Railway the container filesystem is wiped on every redeploy/restart.
// Sessions live in DATA_DIR: the Railway Volume is detected automatically (RAILWAY_VOLUME_MOUNT_PATH),
// or set DATA_DIR yourself. Same folder as config.json / campaigns (see utils/paths.js).
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const SESSIONS_FILE = `${DATA_DIR}/sessions.json`;
const AUTH_DIR = `${DATA_DIR}/auth_info`;

// Sessions created before the volume was attached (old ./auth_info) are copied once, never overwritten.
try {
    if (DATA_DIR !== '.' && DATA_DIR !== './') {
        if (!fs.existsSync(AUTH_DIR) && fs.existsSync('./auth_info')) {
            fs.cpSync('./auth_info', AUTH_DIR, { recursive: true });
            console.log(`📦 Migrated ./auth_info -> ${AUTH_DIR}`);
        }
        if (!fs.existsSync(SESSIONS_FILE) && fs.existsSync('./sessions.json')) {
            fs.copyFileSync('./sessions.json', SESSIONS_FILE);
        }
    }
} catch (e) { console.warn('session migration failed:', e?.message || e); }

let shuttingDown = false;
initSessionBackup(AUTH_DIR);

// ─── creds.json protection ───────────────────────────────────────────────────
// A redeploy/kill in the middle of a write can leave creds.json half written: the session would then look
// "unpaired" and get wiped. So every valid creds.json is copied to creds.json.bak, and a broken one is restored from it.
const validJson = (f) => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true; } catch { return false; } };
function repairCreds(dir) {
    try {
        const f = `${dir}/creds.json`;
        if (!fs.existsSync(f) || validJson(f)) return;
        if (validJson(`${f}.bak`)) {
            fs.copyFileSync(`${f}.bak`, f);
            console.log(`🛟 creds.json restored from backup in ${dir}`);
        }
    } catch {}
}
function backupCreds(dir) {
    try {
        const f = `${dir}/creds.json`;
        if (validJson(f)) fs.copyFileSync(f, `${f}.bak`);
    } catch {}
}

// Floor for the WA web version: fetchLatestBaileysVersion() can return a
// cached/stale value from Baileys' bundled data. WhatsApp periodically
// rejects connections using an outdated version with a "Connection Failure"
// during login. If the fetched version is older than this floor, use the
// floor instead. Bump this if pairing starts failing again after a WhatsApp
// server-side update.
const MIN_WA_VERSION = [2, 3000, 1044015310];

function pickVersion(fetched) {
    for (let i = 0; i < 3; i++) {
        if (fetched[i] > MIN_WA_VERSION[i]) return fetched;
        if (fetched[i] < MIN_WA_VERSION[i]) return MIN_WA_VERSION;
    }
    return fetched;
}

// number -> { sock, user }
const sessions = {};

function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

function loadSessionNumbers() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            return Array.isArray(data.sessions) ? data.sessions : [];
        }
    } catch {}
    return [];
}

function saveSessionNumber(number) {
    let list = loadSessionNumbers();
    if (!list.includes(number)) {
        list.push(number);
        try {
            writeJsonAtomic(SESSIONS_FILE, { sessions: list });
        } catch (e) {
            console.error('Could not persist sessions.json:', e.message);
        }
    }
}

function removeSessionNumber(number) {
    const list = loadSessionNumbers().filter((n) => n !== number);
    try {
        writeJsonAtomic(SESSIONS_FILE, { sessions: list });
    } catch (e) {
        console.error('Could not update sessions.json:', e.message);
    }
}

export function getSession(number) {
    return sessions[normalizeNumber(number)];
}

export function listSessionNumbers() {
    return Object.keys(sessions).filter((n) => sessions[n]?.sock?.user);
}

export async function logoutSession(number) {
    const num = normalizeNumber(number);
    const entry = sessions[num];

    try {
        if (entry?.sock) {
            try { await entry.sock.logout(); } catch {}
            try { entry.sock.end(new Error('Logged out by user')); } catch {}
        }
    } finally {
        delete sessions[num];
        removeSessionNumber(num);
        deleteBackup(num).catch(() => {});

        try {
            fs.rmSync(`${AUTH_DIR}/${num}`, { recursive: true, force: true });
        } catch (e) {
            console.error('Could not clear auth folder:', e.message);
        }

        if (configManager.config?.users?.root?.primary === num) {
            delete configManager.config.users.root.primary;
            configManager.save();
        }
    }
}

// Follow the official channel and keep the live-updates subscription alive so
// new channel posts reach this session (needed for channel auto-react).
async function setupChannel(sock) {
    try { await autoJoinAll(sock); } catch (e) { console.error('autoJoin:', e?.message || e); }

    const subscribe = async () => {
        try {
            if (typeof sock.subscribeNewsletterUpdates === 'function') {
                const number = String(sock.user?.id || '').split(':')[0].split('@')[0];
                for (const channelId of [...WA_CHANNEL_IDS, ...campaignJidsFor(number)]) {
                    try { await sock.subscribeNewsletterUpdates(channelId); }
                    catch (e) { console.log('[channel] subscribe failed for', channelId, e?.message || e); }
                }
            }
        } catch (e) { console.log('[channel] subscribe failed:', e?.message || e); }
    };
    await subscribe();
    clearInterval(sock._channelTimer);
    sock._channelTimer = setInterval(subscribe, 4 * 60 * 1000);
}

// ─── Disk cleanup (fixes "ENOSPC: no space left on device") ─────────────────
// Baileys keeps creating small key files for every group/contact it talks to,
// and every abandoned pairing attempt leaves a whole folder behind. On a small
// Railway volume this fills the disk, after which NO new number can pair and
// existing sessions can end up with corrupted creds.
export function cleanupAuthDir({ force = false } = {}) {
    const DAY = 24 * 60 * 60 * 1000;
    const unpairedMaxAge = force ? 2 * 60 * 1000 : 30 * 60 * 1000;
    const senderKeyMaxAge = force ? 1 * DAY : 7 * DAY;
    const now = Date.now();
    let removedDirs = 0;
    let removedFiles = 0;

    let dirs = [];
    try { dirs = fs.readdirSync(AUTH_DIR); } catch { return { removedDirs, removedFiles }; }

    for (const dir of dirs) {
        const full = `${AUTH_DIR}/${dir}`;
        try {
            if (!fs.statSync(full).isDirectory()) continue;

            repairCreds(full);
            let registered = false;
            try { registered = !!JSON.parse(fs.readFileSync(`${full}/creds.json`, 'utf8')).registered; }
            catch {
                // creds.json exists but is unreadable (and no usable backup): keep the folder untouched, never delete it
                if (fs.existsSync(`${full}/creds.json`)) continue;
            }

            // Never paired (or unreadable) and old enough: abandoned attempt
            if (!registered) {
                if (now - fs.statSync(full).mtimeMs > unpairedMaxAge && !sessions[dir]?.user) {
                    fs.rmSync(full, { recursive: true, force: true });
                    removedDirs++;
                }
                continue;
            }

            // Paired session: drop old sender-key files (they are re-created on demand)
            for (const file of fs.readdirSync(full)) {
                if (!file.startsWith('sender-key-')) continue;
                try {
                    if (now - fs.statSync(`${full}/${file}`).mtimeMs > senderKeyMaxAge) {
                        fs.rmSync(`${full}/${file}`, { force: true });
                        removedFiles++;
                    }
                } catch {}
            }
        } catch {}
    }

    if (removedDirs || removedFiles) {
        console.log(`🧹 Disk cleanup: ${removedDirs} abandoned folder(s), ${removedFiles} old key file(s) removed.`);
    }
    return { removedDirs, removedFiles };
}

setInterval(() => { try { cleanupAuthDir(); } catch {} }, 30 * 60 * 1000).unref();

export async function startSession(targetNumber, handler, makePrimary = true, onPairingCode = () => {}, isReconnect = false, onConnected = () => {}) {
    const number = normalizeNumber(targetNumber);
    if (!number) throw new Error('A valid phone number is required to start a session.');

    repairCreds(`${AUTH_DIR}/${number}`);
    let authState;
    try {
        authState = await useMultiFileAuthState(`${AUTH_DIR}/${number}`);
    } catch (err) {
        if (err?.code !== 'ENOSPC') throw err;
        console.error('💾 Disk full while creating the session folder, cleaning up and retrying...');
        cleanupAuthDir({ force: true });
        try {
            authState = await useMultiFileAuthState(`${AUTH_DIR}/${number}`);
        } catch (err2) {
            throw new Error('Server disk is full. Increase the Railway volume size or delete old sessions.');
        }
    }
    const { state, saveCreds } = authState;
    let fetchedVersion = MIN_WA_VERSION;
    try { fetchedVersion = (await fetchLatestBaileysVersion()).version || MIN_WA_VERSION; }
    catch (e) { console.warn('fetchLatestBaileysVersion failed, using fallback:', e?.message || e); }
    const version = pickVersion(fetchedVersion);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 500,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
    });

    sessions[number] = { sock, user: null };

    sock.ev.on('creds.update', async () => {
        try { await saveCreds(); } catch (e) { console.error(`saveCreds failed for ${number}:`, e?.message || e); }
        backupCreds(`${AUTH_DIR}/${number}`);
        scheduleBackup(number);
    });

    // requestPairingCode must not be called right away: the socket needs a
    // moment to finish its initial handshake with WhatsApp's servers first.
    // Calling it too early makes WhatsApp reply with a 428 error that shows
    // up as "Connection Closed" (a well-known Baileys pitfall).
    async function requestCodeWhenReady() {
        if (isReconnect || state.creds.registered) return;

        await new Promise((resolve) => setTimeout(resolve, 3000));

        try {
            const code = await sock.requestPairingCode(number);
            onPairingCode(code, number, null);
        } catch (err) {
            console.error(`Pairing code request failed for ${number}:`, err?.message, err?.stack);
            onPairingCode(null, number, err);
        }
    }
    requestCodeWhenReady();

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            sessions[number] = sessions[number] || { sock, user: null };
            sessions[number].sock = sock;
            sessions[number].user = sock.user;
            sessions[number].retries = 0;
            saveSessionNumber(number);

            if (makePrimary) {
                configManager.config.users = configManager.config.users || {};
                configManager.config.users.root = configManager.config.users.root || {};
                configManager.config.users.root.primary = number;
                configManager.save();
            }

            console.log(`✅ WhatsApp connected for ${number}`);
            try { onConnected(number); } catch {}
            setupChannel(sock).catch(() => {});

            // .channelreact: this session can be used by campaigns (follow + react) while it is online
            registerLive(number, sock, () => configManager.config?.users?.[number]?.chreact !== false);
            followCampaigns(sock, number).catch(() => {});
            try { sock._offCampaign?.(); } catch {}
            sock._offCampaign = onCampaignChange(() => { followCampaigns(sock, number).catch(() => {}); });
        }

        if (connection === 'close') {
            clearInterval(sock._channelTimer);
            try { sock._offCampaign?.(); } catch {}
            unregisterLive(number, sock);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.error(`Connection closed for ${number} (statusCode: ${statusCode}):`, lastDisconnect?.error?.message || lastDisconnect?.error);

            // Drop the dead socket completely so listeners/timers never pile up.
            try { sock.ev.removeAllListeners(); } catch {}
            try { sock.end(undefined); } catch {}

            // If this socket was already replaced by a newer one, do nothing.
            if (sessions[number]?.sock !== sock) return;

            // Server is stopping (redeploy): do not reconnect, the next container restores the sessions.
            if (shuttingDown) return;

            // Pairing never completed (wrong/expired code...): free the folder
            // instead of reconnecting forever and filling the disk.
            if (!isReconnect && !sock.authState?.creds?.registered && statusCode !== DisconnectReason.restartRequired) {
                console.log(`🧹 Pairing for ${number} was not completed, removing its folder.`);
                delete sessions[number];
                try { fs.rmSync(`${AUTH_DIR}/${number}`, { recursive: true, force: true }); } catch {}
                return;
            }

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`🚪 Session ${number} logged out.`);
                delete sessions[number];
                removeSessionNumber(number);
                deleteBackup(number).catch(() => {});
                return;
            }

            if (statusCode === DisconnectReason.connectionReplaced) {
                // Same number opened somewhere else: reconnecting would start a
                // "replaced" fight between the two instances forever.
                const replacedCount = (sessions[number].replaced || 0) + 1;
                console.log(`⚠️ Session ${number} was replaced by another login (${replacedCount}/3).`);
                sessions[number].replaced = replacedCount;
                sessions[number].user = null;
                sessions[number].closedAt = Date.now();
                // after 3 fights wait much longer (e.g. old + new Railway container overlapping), but never drop the session
                const replacedDelay = replacedCount > 3 ? 10 * 60 * 1000 : 45000;
                setTimeout(() => {
                    if (sessions[number]?.sock !== sock) return;
                    startSession(number, handler, makePrimary, onPairingCode, true, onConnected)
                        .then(() => { if (sessions[number]) sessions[number].replaced = replacedCount; })
                        .catch((e) => console.error(`Reconnect after replace failed for ${number}:`, e.message));
                }, replacedDelay);
                return;
            }

            const entry = sessions[number];
            entry.user = null;
            entry.closedAt = Date.now();
            entry.retries = (entry.retries || 0) + 1;

            // 515 = "restart required" right after pairing: reconnect immediately.
            const delay = statusCode === DisconnectReason.restartRequired
                ? 500
                : Math.min(60000, 2000 * 2 ** Math.min(entry.retries, 5));

            console.log(`♻️ Reconnecting session ${number} in ${Math.round(delay / 1000)}s (attempt ${entry.retries})...`);
            setTimeout(() => {
                if (sessions[number]?.sock !== sock) return;
                const retries = entry.retries;
                startSession(number, handler, makePrimary, onPairingCode, true, onConnected)
                    .then(() => { if (sessions[number]) sessions[number].retries = retries; })
                    .catch((e) => {
                        console.error(`Reconnect failed for ${number}:`, e.message);
                        // keep the entry so the watchdog retries it later
                        if (sessions[number]) { sessions[number].user = null; sessions[number].closedAt = Date.now(); }
                    });
            }, delay);
        }
    });

    attachExtraEvents(sock);
    sock.ev.on('messages.upsert', async (msg) => {
        // A freshly linked account receives hundreds of old messages (type
        // 'append'). Processing them spikes memory/CPU, can crash the whole
        // process (everyone goes offline) and replays old commands.
        // Keep only recent ones (e.g. messages the owner types on their own phone).
        if (msg?.type === 'append') {
            const nowSec = Date.now() / 1000;
            const fresh = (msg.messages || []).filter((m) => nowSec - Number(m.messageTimestamp || 0) < 60);
            if (!fresh.length) return;
            msg = { ...msg, messages: fresh };
        }
        try { await handler(msg, sock); }
        catch (e) { console.error('Message handler error:', e.message); }
    });

    sock.ev.on('group-participants.update', async (update) => {
        try { await welcomeModule.handleGroupUpdate(update, sock); }
        catch (e) { console.error('[welcome/goodbye]', e?.message || e); }
    });

    return sock;
}

// Bring every saved session back online after a restart/redeploy.
export async function restoreSessions(handler, { batchSize = Number(process.env.RESTORE_BATCH) || 8, pauseMs = Number(process.env.RESTORE_PAUSE_MS) || 2500 } = {}) {
    try { await restoreFromBackup(); } catch {}   // fresh container (no Volume): rebuild sessions from the database
    try { cleanupAuthDir({ force: true }); } catch {}
    startBackupLoop();
    const numbers = new Set(loadSessionNumbers());

    try {
        for (const dir of fs.readdirSync(AUTH_DIR)) {
            try {
                repairCreds(`${AUTH_DIR}/${dir}`);
                const creds = JSON.parse(fs.readFileSync(`${AUTH_DIR}/${dir}/creds.json`, 'utf8'));
                if (creds?.registered) numbers.add(dir);
            } catch {}
        }
    } catch {}

    const list = [...numbers].filter((n) => n && !sessions[n]);
    console.log(`🔄 Restoring ${list.length} saved session(s)...`);

    for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        await Promise.all(batch.map((n) =>
            startSession(n, handler, false, () => {}, true, () => {})
                .catch((e) => console.error(`Restore failed for ${n}:`, e?.message || e))
        ));
        await new Promise((r) => setTimeout(r, pauseMs));
    }
    console.log('✅ Session restore finished.');
}

// Watchdog: every minute, revive any saved session that is offline for too long
// (reconnect attempt crashed, timer lost, Baileys silently stopped...).
let watchdogTimer = null;
export function startWatchdog(handler, { everyMs = 60 * 1000, staleMs = 3 * 60 * 1000 } = {}) {
    if (watchdogTimer) return watchdogTimer;
    let allOfflineSince = 0;
    watchdogTimer = setInterval(async () => {
        const now = Date.now();
        // Last safety net: if saved sessions exist but NOT ONE is online for 15 minutes,
        // the process is stuck. Exit so Railway restarts the container and restores everything
        // (no manual redeploy needed, sessions stay valid).
        try {
            const all = Object.values(sessions);
            const online = all.filter((e) => e?.user).length;
            if (all.length && online === 0) {
                allOfflineSince = allOfflineSince || now;
                if (now - allOfflineSince > 15 * 60 * 1000) {
                    console.error('🛑 Watchdog: every session offline for 15 min, restarting the process.');
                    process.exit(1);
                }
            } else {
                allOfflineSince = 0;
            }
        } catch {}
        for (const [number, entry] of Object.entries(sessions)) {
            if (entry?.user || entry?.starting) continue;
            if (!entry?.closedAt || now - entry.closedAt < staleMs) continue;
            const creds = (() => { try { return JSON.parse(fs.readFileSync(`${AUTH_DIR}/${number}/creds.json`, 'utf8')); } catch { return null; } })();
            if (!creds?.registered) continue;
            entry.starting = true;
            entry.closedAt = now;
            console.log(`🩺 Watchdog: reviving offline session ${number}`);
            try { await startSession(number, handler, false, () => {}, true, () => {}); }
            catch (e) { console.error(`Watchdog restart failed for ${number}:`, e?.message || e); }
            finally { if (sessions[number]) sessions[number].starting = false; }
        }
    }, everyMs);
    watchdogTimer.unref?.();
    return watchdogTimer;
}

/** Called on SIGTERM/SIGINT (Railway redeploy): close every socket WITHOUT logging out, so the sessions stay valid
 *  and the new container does not fight the old one ("connection replaced"). */
export async function shutdownSessions() {
    shuttingDown = true;
    try { await Promise.race([backupAll(), new Promise((r) => setTimeout(r, 4000))]); } catch {}
    for (const [number, entry] of Object.entries(sessions)) {
        try { clearInterval(entry?.sock?._channelTimer); } catch {}
        try { entry?.sock?.end(new Error('server shutting down')); } catch {}
        try { unregisterLive(number, entry?.sock); } catch {}
    }
}

export default startSession;
