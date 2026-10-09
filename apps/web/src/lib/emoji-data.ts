export type EmojiCategory = 'smileys' | 'gestures' | 'animals' | 'food' | 'activities' | 'travel' | 'objects' | 'symbols';
export interface EmojiEntry { emoji: string; category: EmojiCategory; keywords: string }
const groups: Record<EmojiCategory, string> = {
  smileys: '😀 😃 😄 😁 😆 😅 😂 🙂 🙃 🫠 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😶‍🌫️ 😏 😒 🙄 😬 😮‍💨 🤥 🫨 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾',
  gestures: '👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦',
  animals: '🐵 🐒 🦍 🦧 🐶 🐕 🦮 🐕‍🦺 🐩 🐺 🦊 🦝 🐱 🐈 🦁 🐯 🐅 🐆 🐴 🫎 🫏 🐎 🦄 🦓 🦌 🦬 🐮 🐂 🐃 🐄 🐷 🐖 🐗 🐽 🐏 🐑 🐐 🐪 🐫 🦙 🦒 🐘 🦣 🦏 🦛 🐭 🐁 🐀 🐹 🐰 🐇 🐿️ 🦫 🦔 🦇 🐻 🐻‍❄️ 🐨 🐼 🦥 🦦 🦨 🦘 🦡 🐾 🦃 🐔 🐓 🐣 🐤 🐥 🐦 🐧 🕊️ 🦅 🦆 🦢 🦉 🦤 🪶 🦩 🦚 🦜 🐸 🐊 🐢 🦎 🐍 🐲 🐉 🦕 🦖 🐳 🐋 🐬 🦭 🐟 🐠 🐡 🦈 🐙 🐚 🪸 🪼 🐌 🦋 🐛 🐜 🐝 🪲 🐞 🦗 🪳 🕷️ 🦂 🦟 🪰 🪱',
  food: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🫒 🥑 🍆 🥔 🥕 🌽 🌶️ 🫑 🥒 🥬 🥦 🧄 🧅 🍄 🥜 🫘 🌰 🍞 🥐 🥖 🫓 🥨 🥯 🥞 🧇 🧀 🍖 🍗 🥩 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🫔 🥙 🧆 🥚 🍳 🥘 🍲 🫕 🥣 🥗 🍿 🧈 🧂 🥫 🍱 🍘 🍙 🍚 🍛 🍜 🍝 🍠 🍢 🍣 🍤 🍥 🥮 🍡 🥟 🥠 🥡 🦀 🦞 🦐 🦑 🦪 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 🍭 🍮 🍯 🍼 🥛 ☕ 🫖 🍵 🍶 🍾 🍷 🍸 🍹 🍺 🍻 🥂 🥃 🫗 🧋 🧃 🧉',
  activities: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🪗 🎸 🪕 🎻 🪈 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩',
  travel: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🛺 🚲 🛴 🛹 🛼 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 🚁 🚟 🚠 🚡 🛰️ 🚀 🛸 🚢 ⛵ 🛶 🚤 🛥️ 🛳️ ⚓ 🗺️ 🗼 🗽 🗿 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🛕 🕍 ⛩️ 🌅 🌄 🌠 🎑',
  objects: '⌚ 📱 📲 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ 🧭 ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🪫 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 🪪 💎 ⚖️ 🪜 🧰 🪛 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ 🧲 🔫 💣 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🏺 🪞 🪟 🛏️ 🛋️ 🪑 🚽 🪠 🚿 🛁 🪤 🧴 🧷 🧹 🧺 🧻 🪣 🧼 🫧 🪥 🧽 🧯 🛒 🚪 🪑 🪆',
  symbols: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💋 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤 ♨️ 💣 ⭐ 🌟 ✨ ⚡ ☄️ 💥 🔥 🌈 ☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💧 💦 ☔ 🌊 🎵 🎶 🔔 🔕 📣 📢 🔊 🔉 🔈 🔇 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❕ ❗ ⚠️ 🚫 ⛔ 💠 🔷 🔶 🔺 🔻 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🔳 🔲 ◻️ ◼️ ▫️ ▪️ 🔘 🔝 🔜 🔛 🔚 🔙 🔃 🔄 🔁 🔂 ➰ ➿ ⤴️ ⤵️ 🔀 🔂 🔼 🔽 ⏩ ⏪ ⏫ ⏬ ⏹️ ⏺️ ⏏️ ▶️ ⏸️ ⏭️ ⏮️ 🆕 🆗 🆙 🆓 🆒 🆖 🆘 🆔 🔤 🔡 🔠 🔣 🔢 #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🇺🇸 🇬🇧 🇹🇭 🇯🇵 🇰🇷 🇨🇳 🇮🇳 🇫🇷 🇩🇪 🇪🇸 🇮🇹 🇧🇷 🇨🇦 🇦🇺 🇳🇿 🇸🇬 🇲🇾 🇮🇩 🇻🇳 🇵🇭 🇲🇽 🇿🇦 🇳🇬 🇪🇬 🇹🇷 🇺🇦 🇷🇺 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇳🇱 🇵🇱 🇨🇭 🇦🇷 🇨🇱 🇨🇴 🇵🇪 🇵🇰 🇧🇩 🇳🇵 🇱🇰 🇭🇰 🇹🇼 🇲🇴',
};
const labels: Record<EmojiCategory, string> = {
  smileys: 'smile happy laugh sad face หน้า ยิ้ม หัวเราะ เศร้า ร้องไห้ โกรธ ตลก',
  gestures: 'hand people gesture love thank มือ คน ท่าทาง รัก ขอบคุณ ยกนิ้ว',
  animals: 'animal nature pet สัตว์ ธรรมชาติ สัตว์เลี้ยง ต้นไม้ ดอกไม้',
  food: 'food drink fruit meal อาหาร เครื่องดื่ม ผลไม้ กิน ขนม',
  activities: 'sport game music activity กีฬา เกม ดนตรี กิจกรรม ฟุตบอล',
  travel: 'travel place transport เดินทาง สถานที่ รถ เครื่องบิน เรือ',
  objects: 'object tool technology ของใช้ เครื่องมือ เทคโนโลยี โทรศัพท์ เงิน',
  symbols: 'symbol heart weather flag สัญลักษณ์ หัวใจ อากาศ ธง ดาว',
};
export const emojiEntries: EmojiEntry[] = Object.entries(groups).flatMap(([category, list]) => {
  const matches = Array.from(list.matchAll(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu), match => match[0]);
  return [...new Set(matches)].map(emoji => ({ emoji, category: category as EmojiCategory, keywords: `${labels[category as EmojiCategory]} ${emoji}` }));
});

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Mirrors the API's ReactionEmoji::normalize — one emoji grapheme (flag, keycap, or pictographic cluster), else null. */
export function pastedEmoji(input: string): string | null {
  const text = input.trim();
  if (!graphemes || text === '' || [...text].length > 32) return null;
  const parts = [...graphemes.segment(text)];
  if (parts.length !== 1) return null;
  const cluster = parts[0]!.segment;
  if (/^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(cluster)) return cluster;
  const keycap = /^([0-9#*])️?⃣$/u.exec(cluster);
  if (keycap) return `${keycap[1]}️⃣`;
  if (!/^\p{Extended_Pictographic}/u.test(cluster)) return null;
  return [...cluster].length === 1 && cluster.codePointAt(0)! < 0x1F000 ? `${cluster}️` : cluster;
}
