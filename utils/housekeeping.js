// Disk housekeeping: fixes "ENOSPC: no space left on device" (the error shown by .menu and other commands).
//
// Temporary files (stickers, audio conversions, Baileys upload buffers) pile up when a command fails half way,
// and on a small Railway disk this ends with every command answering "ENOSPC". This module:
//   - deletes old temp files at boot and every 10 minutes
//   - exposes freeSpace() so a failing command can clean up and retry once (see messageHandler.js)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupAuthDir } from './connector.js';

const TEMP_DIRS = ['./temp', './tmp'].map((d) => path.resolve(d));
const MIN = 60 * 1000;

function sweep(dir, maxAgeMs, onlyFiles = true) {
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return 0; }
    const now = Date.now();
    for (const name of entries) {
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (now - st.mtimeMs < maxAgeMs) continue;
            if (st.isFile()) { fs.rmSync(full, { force: true }); removed++; }
            else if (!onlyFiles && st.isDirectory()) { fs.rmSync(full, { recursive: true, force: true }); removed++; }
        } catch {}
    }
    return removed;
}

/** Remove leftovers. force = true also removes anything older than 1 minute (used when the disk is already full). */
export function freeSpace({ force = false } = {}) {
    const age = force ? 1 * MIN : 10 * MIN;
    let removed = 0;
    for (const d of TEMP_DIRS) removed += sweep(d, age);
    removed += sweep(os.tmpdir(), force ? 2 * MIN : 30 * MIN);   // Baileys encrypts uploads into the system temp dir
    // leftover tag audios of numbers that no longer exist are tiny, the auth folder cleanup does the heavy part
    try { removed += cleanupAuthDir({ force }).removedFiles; } catch {}
    if (removed) console.log(`🧹 Housekeeping: ${removed} leftover file(s) removed${force ? ' (emergency)' : ''}.`);
    return removed;
}

export const isNoSpace = (e) => e?.code === 'ENOSPC' || /ENOSPC|no space left/i.test(String(e?.message || ''));

setTimeout(() => { try { freeSpace(); } catch {} }, 5000).unref();
setInterval(() => { try { freeSpace(); } catch {} }, 10 * MIN).unref();
