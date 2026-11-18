// Optional safety net for hosts WITHOUT a persistent disk.
//
// Railway wipes the container filesystem at every redeploy. If no Volume is attached, the WhatsApp sessions
// (auth_info/<number>) are lost and everybody has to pair again. When the DATABASE_URL variable exists
// (add a Railway "PostgreSQL" database to the project: it is injected automatically), every session folder is
// copied to the database and restored at startup, BEFORE the sessions are reopened.
//
//   - backup : ~20 s after a session's credentials change, plus a full pass every 3 minutes and on shutdown
//   - restore: at boot, any session whose folder is missing or whose creds.json is unreadable
//   - without DATABASE_URL (or without the "pg" package) this module does nothing
import fs from 'fs';

const ENABLED_URL = process.env.DATABASE_URL || process.env.SESSION_BACKUP_URL || '';
const SKIP = /^sender-key-/;          // re-created on demand, big and useless to keep
let authDir = './auth_info';
let pool = null;
let ready = false;
const lastHash = new Map();           // number -> hash of the last uploaded snapshot
const timers = new Map();             // number -> debounce timer

const log = (...a) => console.log('[session-backup]', ...a);

async function getPool() {
    if (!ENABLED_URL) return null;
    if (pool) return pool;
    try {
        const pg = await import('pg');
        const Pool = pg.default?.Pool || pg.Pool;
        const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(ENABLED_URL);
        pool = new Pool({ connectionString: ENABLED_URL, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
        pool.on('error', (e) => log('pool error:', e?.message || e));
        await pool.query(`CREATE TABLE IF NOT EXISTS kz_sessions (
            number TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
        ready = true;
        return pool;
    } catch (e) {
        log('disabled:', e?.message || e);
        pool = null;
        return null;
    }
}

export const backupEnabled = () => Boolean(ENABLED_URL);

function snapshot(number) {
    const dir = `${authDir}/${number}`;
    const files = {};
    for (const f of fs.readdirSync(dir)) {
        if (SKIP.test(f) || f.endsWith('.tmp')) continue;
        try {
            const st = fs.statSync(`${dir}/${f}`);
            if (!st.isFile() || st.size > 2_000_000) continue;
            files[f] = fs.readFileSync(`${dir}/${f}`, 'utf8');
        } catch {}
    }
    try { JSON.parse(files['creds.json']); } catch { return null; }   // never back up a broken/missing creds.json
    return files;
}

export async function backupSession(number) {
    const p = await getPool();
    if (!p || !ready) return false;
    try {
        const files = snapshot(number);
        if (!files) return false;
        const body = JSON.stringify(files);
        if (lastHash.get(number) === body.length + ':' + (files['creds.json'] || '').length + ':' + Object.keys(files).length + ':' + body.slice(-64)) return true;
        await p.query(
            `INSERT INTO kz_sessions (number, data, updated_at) VALUES ($1, $2::jsonb, now())
             ON CONFLICT (number) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [number, body]);
        lastHash.set(number, body.length + ':' + (files['creds.json'] || '').length + ':' + Object.keys(files).length + ':' + body.slice(-64));
        return true;
    } catch (e) {
        log(`backup failed for ${number}:`, e?.message || e);
        return false;
    }
}

/** Call when a session's credentials change: uploads a few seconds later (many changes = one upload). */
export function scheduleBackup(number, ms = 20_000) {
    if (!ENABLED_URL) return;
    clearTimeout(timers.get(number));
    const t = setTimeout(() => { timers.delete(number); backupSession(number); }, ms);
    t.unref?.();
    timers.set(number, t);
}

export async function backupAll() {
    const p = await getPool();
    if (!p) return 0;
    let n = 0;
    let dirs = [];
    try { dirs = fs.readdirSync(authDir); } catch { return 0; }
    for (const d of dirs) {
        try { if (await backupSession(d)) n++; } catch {}
    }
    return n;
}

export async function deleteBackup(number) {
    const p = await getPool();
    if (!p) return;
    try { await p.query('DELETE FROM kz_sessions WHERE number = $1', [number]); lastHash.delete(number); } catch {}
}

const validJson = (f) => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true; } catch { return false; } };

/** Boot: rebuild the sessions that are missing on disk (fresh container after a redeploy). */
export async function restoreFromBackup() {
    const p = await getPool();
    if (!p) return 0;
    let restored = 0;
    try {
        const { rows } = await p.query('SELECT number, data FROM kz_sessions');
        for (const row of rows) {
            const dir = `${authDir}/${row.number}`;
            if (validJson(`${dir}/creds.json`)) continue;      // the disk copy is fine (Volume): keep it
            try {
                fs.mkdirSync(dir, { recursive: true });
                for (const [name, content] of Object.entries(row.data || {})) {
                    if (/[\\/]/.test(name)) continue;
                    fs.writeFileSync(`${dir}/${name}`, content);
                }
                restored++;
            } catch (e) { log(`restore failed for ${row.number}:`, e?.message || e); }
        }
        log(`${restored} session(s) restored from the database (${rows.length} saved)`);
    } catch (e) { log('restore failed:', e?.message || e); }
    return restored;
}

let loop = null;
export function initSessionBackup(dir) {
    authDir = dir;
    if (!ENABLED_URL) {
        log('off (no DATABASE_URL). Without a Railway Volume, sessions are lost at every redeploy.');
        return;
    }
    getPool().then((p) => p && log('on: sessions are copied to the database'));
}
export function startBackupLoop(everyMs = 3 * 60 * 1000) {
    if (!ENABLED_URL || loop) return;
    loop = setInterval(() => { backupAll().catch(() => {}); }, everyMs);
    loop.unref?.();
}
