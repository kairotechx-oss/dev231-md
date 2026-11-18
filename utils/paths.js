// Single place that decides WHERE the bot keeps its data (sessions, config, settings, campaigns).
//
// On Railway the container filesystem is wiped at every redeploy. Only a Volume survives.
// When a Volume is attached, Railway gives us its mount path in RAILWAY_VOLUME_MOUNT_PATH,
// so sessions are kept automatically: nobody has to pair again after a redeploy.
// DATA_DIR (if set) always wins.
import fs from 'fs';
import path from 'path';

export const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
export const PERSISTENT = DATA_DIR !== '.' && DATA_DIR !== './';

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

export const dataPath = (...parts) => path.join(DATA_DIR, ...parts);

// Running on Railway but nothing persistent mounted: every redeploy will log everybody out.
if (!PERSISTENT && (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID)) {
    console.warn('⚠️ NO VOLUME DETECTED: sessions will be lost at the next redeploy. Add a Railway Volume (mount path /data).');
} else {
    console.log(`💾 Data directory: ${path.resolve(DATA_DIR)}${PERSISTENT ? ' (persistent)' : ''}`);
}

/** Copy a legacy file (old location) to its new place once, never overwriting. */
export function migrateFile(oldPath, newPath) {
    try {
        if (path.resolve(oldPath) === path.resolve(newPath)) return;
        if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return;
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.copyFileSync(oldPath, newPath);
        console.log(`📦 Migrated ${oldPath} -> ${newPath}`);
    } catch (e) { console.warn('migrateFile failed:', e?.message || e); }
}

/** Atomic JSON write (temp file + rename): a crash in the middle can never leave a half-written file. */
export function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}
