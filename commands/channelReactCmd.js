// .channelreact [on|off|<channel link>] — the user gives THEIR channel link.
// Up to 40 other connected sessions follow it (free followers) and react to its latest post;
// the same round is repeated every day for 5 days and each new post gets up to 40 reactions.
// Engine: commands/channelBoost.js (same system as NEXORA MD).
import configManager from '../utils/manageConfigs.js';
import { ensure } from './configCommands.js';
import {
    startBoost, giveBoost, stopBoost, campaignOf, awaitLink, isAwaitingLink, clearAwaiting,
    CHANNEL_LINK, BOOST_SIZE, BOOST_MS, lastBoostError, reactionModeOf, postHintOf,
} from './channelBoost.js';

const box = (title, lines) => `╭━━〔 ${title} 〕━━⟡\n${lines.map((l) => `┃ ${l}`).join('\n')}\n╰━━━━━━━━━━━━━━━━⟡`;
const DAYS = Math.round(BOOST_MS / (24 * 3600 * 1000));
const log = (lvl, msg, extra) => console.log(`[channelreact:${lvl}] ${msg}`, extra || '');

const timeLeft = (ms) => {
    const h = Math.max(0, Math.floor(ms / 3_600_000));
    return `${Math.floor(h / 24)}d ${h % 24}h`;
};

function status(number) {
    const cfg = ensure(number);
    const c = campaignOf(number);
    const lines = [`React : ${cfg.chreact !== false ? 'ON' : 'OFF'}`];
    if (c) lines.push(`Your channel : ${c.name || '—'}`, c.url, `Emojis : ${c.emojis.join(' ')}`, `Time left : ${timeLeft(c.until - Date.now())}`);
    else lines.push('Your channel : none yet');
    return lines;
}

async function applyLink(message, client, number, prefix, link, postHint = null) {
    const jid = message.key.remoteJid;
    const reply = (text) => client.sendMessage(jid, { text }, { quoted: message });
    const cfg = ensure(number);
    if (cfg.chreact === false) { cfg.chreact = true; configManager.save(); }
    clearAwaiting(number);

    await reply(box('🔎 CHANNEL REACT', ['Checking the channel…']));
    const r = await startBoost(client, link, number, postHint);
    if (!r.ok) {
        const why = { invalid_link: 'Invalid channel link.', not_found: 'Channel not found.', full: 'Too many channels are running right now. Try again later.' }[r.reason];
        const detail = r.reason === 'not_found' && lastBoostError() ? [`Reason : ${lastBoostError()}`] : [];
        return reply(box('❌ CHANNEL REACT', [why, ...detail, 'Example : https://whatsapp.com/channel/XXXX']));
    }
    await reply(box('📣 CHANNEL REACT ✅', [
        `Channel : ${r.campaign.name || '—'}`,
        r.campaign.url,
        `Emojis : ${r.campaign.emojis.join(' ')}`,
        `Sending ${BOOST_SIZE} followers + ${BOOST_SIZE} reactions…`,
    ]));

    let res = { pool: 0, followers: 0, followersSkipped: false, reacts: 0 };
    try { res = await giveBoost(client, r.campaign, log); }
    catch (e) { log('warn', 'give failed', String(e?.message || '').slice(0, 60)); }

    const lines = [`Channel : ${r.campaign.name || '—'}`, `Accounts online : ${res.pool}`];
    if (res.followers) lines.push(`Followers : +${res.followers} 🎁`);
    else if (res.followersSkipped) lines.push('Free followers : already given today');
    else if (!res.pool) lines.push('Followers : 0 (no other connected account right now)');
    lines.push(`Reactions : ${res.reacts}`);
    if (reactionModeOf(r.campaign.jid) === 'BASIC') {
        lines.push('ℹ️ This channel accepts only the 6 basic reactions (👍 ❤️ 😂 😮 😢 🙏), so only those are used.',
            'To allow all emojis: Channel settings → Reactions → All emojis.');
    }
    if (res.pending && res.reacts < Math.min(res.pool, BOOST_SIZE)) {
        lines.push('🔁 The missing reactions are sent automatically in the next minutes (no need to do anything).');
    }
    if (!res.reacts) {
        lines.push('⚠️ No reaction could be sent. Check that the link is a channel you can see, then try again in a minute.');
        if (lastBoostError()) lines.push(`Reason : ${lastBoostError()}`);
    }
    if (res.reacts < Math.min(res.pool, BOOST_SIZE) && lastBoostError()) lines.push(`Last error : ${lastBoostError()}`);
    lines.push(`Every day : new reactions, for ${DAYS} days.`, 'New posts : reacted automatically.', `Change channel : ${prefix}channelreact <new link>`);
    return reply(box('✅ CHANNEL REACT', lines));
}

export async function channelreact(message, client, number, args, prefix = '.') {
    const jid = message.key.remoteJid;
    const reply = (text) => client.sendMessage(jid, { text }, { quoted: message });
    const cfg = ensure(number);

    const joined = args.join(' ');
    const link = args.find((a) => CHANNEL_LINK.test(a));
    if (link) return applyLink(message, client, number, prefix, link.match(CHANNEL_LINK)[0], postHintOf(joined));

    const v = String(args[0] || '').toLowerCase();
    if (['off', 'false', '0'].includes(v)) {
        cfg.chreact = false;
        configManager.save();
        stopBoost(number);
        clearAwaiting(number);
        return reply(box('📣 CHANNEL REACT', ['React : OFF ✅', 'Your account no longer reacts and your channel campaign is stopped.']));
    }
    if (['on', 'true', '1'].includes(v) || !v) {
        if (cfg.chreact === false) { cfg.chreact = true; configManager.save(); }
        awaitLink(number);
        return reply(box('📣 CHANNEL REACT', [...status(number), '📎 Send your channel link now.', `(or ${prefix}channelreact <link>)`, `Stop : ${prefix}channelreact off`]));
    }
    return reply(box('📣 CHANNEL REACT', [...status(number), `Usage : ${prefix}channelreact on · off · <channel link>`]));
}

/** A channel link sent alone, right after .channelreact, is taken as the answer. Returns true when handled. */
export async function boostLinkReply(message, client, number, text, prefix = '.') {
    if (!isAwaitingLink(number)) return false;
    const hit = String(text || '').trim().match(/^(https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[\w-]+)(?:\/(\d{1,12}))?\/?$/i);
    if (!hit) return false;
    await applyLink(message, client, number, prefix, hit[1], hit[2] || null);
    return true;
}

export default { channelreact, boostLinkReply };
