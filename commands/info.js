import configManager from '../utils/manageConfigs.js';
import { OWNER_NAME, BOT_VERSION } from '../config.js';
import { bold, CATEGORIES, COMMAND_COUNT, ALIASES } from '../utils/commandList.js';
import fs from 'fs';
import path from 'path';

export async function info(message, client) {
    const remoteJid = message.key.remoteJid;
    const number = client.user.id.split(':')[0];
    const prefix = configManager.config.users?.[number]?.prefix || '.';

    const up = Math.floor(process.uptime());
    const runtime = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m ${up % 60}s`;

    const mode = String(configManager.config.botMode || 'public').toUpperCase();

    const sections = CATEGORIES.map(([icon, title, list]) =>
`『 ${icon} 』${bold(title)}
╭─────────────────╾━━━⟡
${list.map((c) => `┊ ◈ ${prefix}${c}${ALIASES[c] ? ' (' + ALIASES[c].join(', ') + ')' : ''}`).join('\n')}
╰─────────────────━━━𖤓`).join('\n\n');

    const header =
`╭━━━〔 ${bold('KAIRO ZYNEX')} 〕╾━━━⟡
┃✧ ${bold('OWNER')} : ${bold(String(OWNER_NAME).toUpperCase())}
┃✧ ${bold('COMMANDS')} : ${bold(COMMAND_COUNT)}
┃✧ ${bold('RUNTIME')} : ${bold(runtime)}
┃✧ ${bold('PREFIX')} : ${prefix}
┃✧ ${bold('MODE')} : ${bold(mode)}
┃✧ ${bold('VERSION')} : ${bold(BOT_VERSION)}
╰━━━━━━━━━━━━━━━━━━━𖤓`;

    const extra =
`╭━━━〔 ${bold('EXTRA')} 〕━━━⊷
┊ ✧ ${bold('CHANNEL REACT')}
┊ ${prefix}channelreact <channel link>
┊ 40 followers + 40 reactions
┊
┊ ✧ ${bold('STATUS SAVER')}
┊ Reply: ${bold('send')} / ${bold('sendme')} / ${bold('save')}
┊ ${bold('OWNER ONLY')}
┊
┊ ✧ ${bold('PAIRING WEBSITE')}
┊ https://zynex-pair-code.up.railway.app
╰━━━━━━━━━━━━━━━━━━━━𖤓

⟪ ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴋᴀɪʀᴏ 〆 ᴅᴇᴠ ⟫`;

    const options = { quoted: message };
    const imagePath = path.join(process.cwd(), 'menu.jpg');

    // Same look as before: ONE message, banner image on top and the whole menu as its caption.
    const caption = `${header}\n\n${sections}\n\n${extra}`;
    try {
        if (fs.existsSync(imagePath)) {
            await client.sendMessage(remoteJid, { image: fs.readFileSync(imagePath), caption }, options);
        } else {
            await client.sendMessage(remoteJid, { text: caption }, options);
        }
    } catch (e) {
        // Only if WhatsApp refuses the single message (disk full, caption refused...): send the menu as plain text.
        console.log('[menu] single message failed, sending as text:', e?.message || e);
        await client.sendMessage(remoteJid, { text: caption }, options);
    }

    const audioPath = path.join(process.cwd(), 'menu.mp3');
    if (fs.existsSync(audioPath)) {
        try {
            await client.sendMessage(remoteJid, { audio: fs.readFileSync(audioPath), mimetype: 'audio/mpeg', ptt: false }, options);
        } catch (e) {
            console.log('[menu] audio failed:', e?.message || e);
        }
    }
}

export default info;
