// ─── Silence libsignal session spam ──────────────────────────────────────
// libsignal prints whole session objects ("Closing session: SessionEntry {...}")
// on every message from a contact with a new key. With many users this floods
// the Railway logs (hundreds of lines/second) and wastes CPU/memory.
const NOISE = [
    'Closing session', 'Closing open session', 'Opening session', 'Removing old closed session',
    'Migrating session', 'Session already closed', 'Session already open',
    'Failed to decrypt message with any known session', 'Bad MAC', 'Decrypted message with closed session',
];
const isNoise = (args) => typeof args[0] === 'string' && NOISE.some((n) => args[0].startsWith(n));
for (const level of ['log', 'info', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { if (!isNoise(args)) original(...args); };
}

// ─── Global crash guard ──────────────────────────────────────────────────
// Without these, one bad conversion (e.g. a heavy video → sticker job) or
// any unhandled promise rejection anywhere in the app can take the ENTIRE
// bot process down instead of just failing that one command. We log the
// error and keep the bot running.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err);
});

import handleIncomingMessage from './events/messageHandler.js';
import { startPairingServer } from './web/server.js';

(async () => {
    await startPairingServer(handleIncomingMessage);
})();
