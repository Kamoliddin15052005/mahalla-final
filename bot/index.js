require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { userDB, postDB, getMahallaId } = require('../server/db');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } }
});

bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message?.includes('409')) {
    console.log('409 — 5s kutilmoqda...');
    bot.stopPolling().then(() => setTimeout(() => bot.startPolling(), 5000));
  } else {
    console.error('Polling xato:', err.message);
  }
});

const BASE_URL = process.env.MINIAPP_URL || 'http://localhost:3000';

// chatId ni URL hash ga qo'shamiz — Telegram WebApp hash ni o'tkazadi
function getMiniAppUrl(chatId) {
  return `${BASE_URL}?uid=${chatId}`;
}

// ─── /start ──────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const existing = await userDB.findByChatId(chatId);
  if (existing && existing.registered) return sendMainMenu(chatId, existing);

  await userDB.upsertTemp(chatId, { reg_step: 'name' });
  await bot.sendMessage(chatId,
    '🏘️ *Mahalla Botga xush kelibsiz!*\n\n' +
    'Ro\'yxatdan o\'tish uchun *4 ta qadam* bajarasiz.\n\n' +
    '*1-qadam:* Ism, familiya va sharifingizni yozing:\n' +
    '_Masalan: Karimov Alisher Botirovich_',
    { parse_mode: 'Markdown' }
  );
});

// ─── Matn xabarlar ───────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const user = await userDB.findByChatId(chatId);
  if (!user || user.registered) return;

  const step = user.reg_step;

  if (step === 'name') {
    const words = text.trim().split(/\s+/);
    if (words.length < 2) {
      return bot.sendMessage(chatId,
        '❌ Kamida *ism va familiya* kiriting.\n_Masalan: Karimov Alisher Botirovich_',
        { parse_mode: 'Markdown' }
      );
    }
    await userDB.upsertTemp(chatId, { temp_name: text.trim(), reg_step: 'location' });
    return bot.sendMessage(chatId,
      `✅ *${text.trim()}* — saqlandi!\n\n*2-qadam:* Yashash joyi lokatsiyangizni yuboring:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [[{ text: '📍 Lokatsiyamni yuborish', request_location: true }]],
          resize_keyboard: true, one_time_keyboard: true
        }
      }
    );
  }

  if (step === 'phone') {
    const phone = text.replace(/\s/g, '');
    if (!/^\+?\d{9,13}$/.test(phone)) {
      return bot.sendMessage(chatId, '❌ Noto\'g\'ri raqam.\n_Masalan: +998901234567_', { parse_mode: 'Markdown' });
    }
    await userDB.upsertTemp(chatId, { phone, reg_step: 'role' });
    return sendRoleSelection(chatId);
  }

  if (step === 'role') {
    let role = 'aholi';
    if (text.includes('rais')) role = 'rais';
    else if (text.includes('inspektor')) role = 'inspektor';
    await userDB.upsertTemp(chatId, { temp_role: role, reg_step: 'confirm' });
    return sendConfirmation(chatId);
  }

  if (step === 'confirm') {
    if (text.includes('Qayta')) {
      await userDB.upsertTemp(chatId, { reg_step: 'name' });
      return bot.sendMessage(chatId, 'Qayta boshlash uchun /start bosing.');
    }
    if (text.includes('Tasdiqlash') || text.includes('✅')) {
      const finished = await userDB.finishRegistration(chatId);
      if (finished) {
        await bot.sendMessage(chatId,
          `🎉 *Ro'yxatdan muvaffaqiyatli o'tdingiz!*\n\n👤 ${finished.full_name}\n🏷️ Rol: ${finished.role}`,
          { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        return sendMainMenu(chatId, finished);
      }
    }
  }
});

// ─── Lokatsiya ───────────────────────────────────────────────
bot.on('location', async (msg) => {
  const chatId = msg.chat.id;
  const user = await userDB.findByChatId(chatId);
  if (!user || user.registered || user.reg_step !== 'location') return;

  const { latitude: lat, longitude: lng } = msg.location;
  await userDB.upsertTemp(chatId, { temp_lat: lat, temp_lng: lng, reg_step: 'phone' });
  const mahallaId = getMahallaId(lat, lng);
  await bot.sendMessage(chatId,
    `✅ Lokatsiya saqlandi!\n📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}\n🏘️ Hudud: \`${mahallaId}\`\n\n*3-qadam:* Telefon raqamingizni yuboring:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '📱 Raqamimni ulashish', request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true
      }
    }
  );
});

// ─── Kontakt ─────────────────────────────────────────────────
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const user = await userDB.findByChatId(chatId);
  if (!user || user.registered || user.reg_step !== 'phone') return;
  await userDB.upsertTemp(chatId, { phone: msg.contact.phone_number, reg_step: 'role' });
  await sendRoleSelection(chatId);
});

// ─── Rol tanlash ─────────────────────────────────────────────
async function sendRoleSelection(chatId) {
  await bot.sendMessage(chatId, '*4-qadam:* Rolingizni tanlang:', {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [['👥 Aholi'], ['👨‍💼 Mahalla raisi'], ['🔍 Profilaktika inspektori']],
      resize_keyboard: true, one_time_keyboard: true
    }
  });
}

// ─── Tasdiqlash ──────────────────────────────────────────────
async function sendConfirmation(chatId) {
  const u = await userDB.findByChatId(chatId);
  if (!u) return;
  const roleLabel = { aholi: '👥 Aholi', rais: '👨‍💼 Mahalla raisi', inspektor: '🔍 Profilaktika inspektori' };
  await bot.sendMessage(chatId,
    `📋 *Ma'lumotlaringizni tekshiring:*\n\n` +
    `👤 Ism: *${u.temp_name}*\n` +
    `📍 Lokatsiya: *${(u.temp_lat||0).toFixed(4)}, ${(u.temp_lng||0).toFixed(4)}*\n` +
    `📱 Telefon: *${u.phone}*\n` +
    `🏷️ Rol: *${roleLabel[u.temp_role] || 'Aholi'}*\n\nTasdiqlaysizmi?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [['✅ Tasdiqlash', '❌ Qayta boshlash']],
        resize_keyboard: true, one_time_keyboard: true
      }
    }
  );
}

// ─── Asosiy menyu ────────────────────────────────────────────
async function sendMainMenu(chatId, user) {
  const stats = await postDB.getStats(user.mahalla_id);
  // chatId ni URL ga qo'shamiz
  const appUrl = getMiniAppUrl(chatId);
  await bot.sendMessage(chatId,
    `👋 Xush kelibsiz, *${user.full_name}*!\n\n` +
    `🏘️ Mahalla: \`${user.mahalla_id}\`\n` +
    `🔴 Ochiq muammolar: *${stats.pending}* ta\n` +
    `🎉 To'y/tadbirlar: *${stats.toy}* ta`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗺️ Mini Appni ochish', web_app: { url: appUrl } }],
          [
            { text: '📊 Mening ballarim', callback_data: 'score' },
            { text: '👥 A\'zolar', callback_data: 'members' }
          ]
        ]
      }
    }
  );
}

// ─── Callback ────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const user = await userDB.findByChatId(chatId);
  if (!user) return bot.answerCallbackQuery(q.id, { text: 'Avval ro\'yxatdan o\'ting' });

  if (q.data === 'score') {
    await bot.answerCallbackQuery(q.id);
    const top = await userDB.getTop(user.mahalla_id);
    const rank = top.findIndex(u => u.full_name === user.full_name) + 1;
    return bot.sendMessage(chatId,
      `⭐ *Ballaringiz: ${user.score}*\n🏆 ${rank ? rank+'-o\'rin' : 'Hali reyting yo\'q'}\n\n*Top 5:*\n` +
      top.slice(0,5).map((u,i) => `${i+1}. ${u.full_name} — ${u.score} ball`).join('\n'),
      { parse_mode: 'Markdown' }
    );
  }
  if (q.data === 'members') {
    await bot.answerCallbackQuery(q.id);
    const members = await userDB.getByMahalla(user.mahalla_id);
    return bot.sendMessage(chatId,
      `👥 *Mahallada ${members.length} kishi:*\n\n` +
      members.slice(0,10).map(u => `• ${u.full_name} (${u.role})`).join('\n'),
      { parse_mode: 'Markdown' }
    );
  }
  if (q.data?.startsWith('resolve_')) {
    const postId = parseInt(q.data.split('_')[1]);
    await postDB.resolve(postId);
    await bot.answerCallbackQuery(q.id, { text: '✅ Hal qilindi!' });
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: q.message.message_id
    });
  }
});

// ─── Bildirishnoma ───────────────────────────────────────────
async function notifyPost(post, sender) {
  const mahalla = await userDB.getByMahalla(sender.mahalla_id);
  const typeEmoji = { muammo:'🔴', narkotik:'🚨', kasal:'🏥', axlat:'🗑️', jinoyat:'⚠️', boshqa:'💬' };
  const typeLabel = { muammo:'Muammo', narkotik:'Narkotik', kasal:'Kasal', axlat:'Axlat', jinoyat:'Jinoyat', boshqa:'E\'lon' };
  const emoji = typeEmoji[post.type] || '📢';
  const label = typeLabel[post.type] || post.type;

  for (const u of mahalla) {
    if (u.chat_id === sender.chat_id) continue;
    const isOfficial = u.role === 'rais' || u.role === 'inspektor';
    if (!isOfficial && post.type !== 'muammo' && post.type !== 'narkotik' && post.type !== 'jinoyat') continue;
    try {
      await bot.sendMessage(u.chat_id,
        `${emoji} *Yangi ${label}!*\n\n👤 ${sender.full_name}\n📝 ${post.description}`,
        {
          parse_mode: 'Markdown',
          reply_markup: (isOfficial && (post.type==='muammo'||post.type==='narkotik'||post.type==='jinoyat')) ? {
            inline_keyboard: [[{ text: '✅ Hal qilindi', callback_data: `resolve_${post.id}` }]]
          } : undefined
        }
      );
    } catch (e) {}
  }
}

module.exports = { bot, notifyPost };
