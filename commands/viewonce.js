// .vv — recovers a view-once photo / video / voice note: reply to it with .vv
// and the media is sent back in the chat as a normal (re-viewable) message.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { OWNER_NAME } from '../config.js';

const MAX_BYTES = 64 * 1024 * 1024;

// Peels every wrapper WhatsApp can put around a message (view once V1/V2/V2 extension, ephemeral, caption doc).
function unwrap(msg) {
    let cur = msg;
    for (let i = 0; i < 8 && cur; i++) {
        const inner = cur.viewOnceMessageV2?.message
            || cur.viewOnceMessageV2Extension?.message
            || cur.viewOnceMessage?.message
            || cur.ephemeralMessage?.message
            || cur.documentWithCaptionMessage?.message
            || cur.editedMessage?.message;
        if (!inner) break;
        cur = inner;
    }
    return cur || null;
}

function findMedia(content) {
    if (!content) return null;
    if (content.imageMessage) return { kind: 'image', node: content.imageMessage };
    if (content.videoMessage) return { kind: 'video', node: content.videoMessage };
    if (content.audioMessage) return { kind: 'audio', node: content.audioMessage };
    return null;
}

const num = (v) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0);

export async function viewonce(message, client) {
    const remoteJid = message.key.remoteJid;
    const q = { quoted: message };
    const say = (text) => client.sendMessage(remoteJid, { text }, q);

    const root = unwrap(message.message);
    const ci = root?.extendedTextMessage?.contextInfo || root?.imageMessage?.contextInfo || root?.videoMessage?.contextInfo;
    if (!ci?.quotedMessage) {
        return say('👁️ Reply to a view-once photo, video or voice note with .vv');
    }

    const content = unwrap(ci.quotedMessage);
    const media = findMedia(content);
    if (!media) return say('❌ No photo, video or audio found in that message.');
    if (num(media.node.fileLength) > MAX_BYTES) return say('❌ Media too big (max 64 MB).');

    try { await client.sendMessage(remoteJid, { react: { text: '⏳', key: message.key } }); } catch {}

    const fake = {
        key: { remoteJid, id: ci.stanzaId, participant: ci.participant, fromMe: false },
        message: content,
    };

    let buffer = null;
    try {
        buffer = await downloadMediaMessage(fake, 'buffer', {}, { reuploadRequest: client.updateMediaMessage });
    } catch (e1) {
        console.log('[vv] download failed, retrying:', e1?.message || e1);
        try { buffer = await downloadMediaMessage(fake, 'buffer', {}); }
        catch (e2) { console.log('[vv] download failed again:', e2?.message || e2); }
    }

    if (!buffer || !buffer.length) {
        try { await client.sendMessage(remoteJid, { react: { text: '❌', key: message.key } }); } catch {}
        return say('❌ Could not download this media (it may have expired or was already opened on the phone).');
    }

    const caption = `👁️ Recovered ✅\n\n> *_Powered by ${OWNER_NAME}_*`;
    const payload = media.kind === 'image' ? { image: buffer, caption }
        : media.kind === 'video' ? { video: buffer, caption, mimetype: 'video/mp4' }
        : { audio: buffer, mimetype: media.node.mimetype || 'audio/mpeg', ptt: Boolean(media.node.ptt) };

    await client.sendMessage(remoteJid, payload, q);
    try { await client.sendMessage(remoteJid, { react: { text: '✅', key: message.key } }); } catch {}
}

export default viewonce;
