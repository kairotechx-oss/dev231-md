import fs from 'fs';
import { dataPath, migrateFile, writeJsonAtomic } from './paths.js';

// config.json lives in the data directory (Railway Volume) so prefixes, sudo lists,
// toggles and chatbot chats survive a redeploy. An old ./config.json is migrated once.
const configPath = dataPath('config.json');
migrateFile('config.json', configPath);

let config = { users: {} };

if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        // corrupted file: keep a copy and start clean instead of crashing the whole bot
        console.error('config.json unreadable, starting with an empty config:', e?.message || e);
        try { fs.copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}`); } catch {}
        config = { users: {} };
    }
}
config.users ||= {};

// Auto-save when modified (atomic write)
const saveConfig = () => {
    try { writeJsonAtomic(configPath, config); }
    catch (e) { console.error('Could not save config.json:', e?.message || e); }
};

// **Direct Access Object**
export default {
    config,
    save() {
        saveConfig();
    }
};
