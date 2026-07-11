import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = 'sharnenkov/bank-id-weekly';
const DATA_FILE      = 'data-new.json';

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Telegram helpers ──────────────────────────────────────────────────────────

function mdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/\*(.+?)\*/gs, '<i>$1</i>')
    .replace(/__(.+?)__/gs, '<b>$1</b>')
    .replace(/_(.+?)_/gs, '<i>$1</i>')
    .replace(/`(.+?)`/gs, '<code>$1</code>');
}

async function tgSend(chatId, text, opts = {}) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: mdToHtml(text), parse_mode: 'HTML', ...opts }),
  });
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getDataJson() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  const meta = await res.json();
  const content = Buffer.from(meta.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: meta.sha };
}

async function putDataJson(data, sha, commitMsg) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMsg, content, sha }),
    }
  );
  return res.ok;
}

// ── State helpers (stored in GitHub state.json) ────────────────────────────────

const STATE_FILE = 'state.json';

async function getState() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) return { conversations: {}, sha: null };
    const meta = await res.json();
    const content = Buffer.from(meta.content, 'base64').toString('utf8');
    return { conversations: JSON.parse(content), sha: meta.sha };
  } catch { return { conversations: {}, sha: null }; }
}

async function saveState(conversations, sha) {
  const content = Buffer.from(JSON.stringify(conversations, null, 2)).toString('base64');
  const body = { message: 'chore: update bot state', content };
  if (sha) body.sha = sha;
  await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

// ── Human-readable patch preview ──────────────────────────────────────────────

const STREAM_LABELS = { it: 'IT', integrations: 'Интеграции', partners: 'Партнёры', org: 'Оргстрим' };

function previewPatch(patch, data) {
  const lines = [];

  if (patch.streams) {
    for (const [streamKey, streamPatch] of Object.entries(patch.streams)) {
      const label = STREAM_LABELS[streamKey] || streamKey;
      if (streamPatch.done)
        [].concat(streamPatch.done).forEach(s => lines.push(`🔹 <b>${label}:</b> ${s}`));
      if (streamPatch.artifacts)
        [].concat(streamPatch.artifacts).forEach(s => lines.push(`    Артефакт: ${s}`));
    }
  }

  if (patch.milestones && patch.milestones.items) {
    [].concat(patch.milestones.items).forEach(m => {
      const found = data.milestones.items.find(x => x.id === m.id);
      const title = found ? found.title : m.id;
      const parts = [];
      if (m.current !== undefined) parts.push(`текущее ${m.current}`);
      if (m.target  !== undefined) parts.push(`цель ${m.target}`);
      lines.push(`🎯 <b>${title}:</b> ${parts.join(' · ')}`);
    });
  }

  if (patch.budget) {
    const b = patch.budget;
    const parts = [];
    if (b.spent_pct     !== undefined) parts.push(`потрачено ${b.spent_pct}%`);
    if (b.remaining_pct !== undefined) parts.push(`остаток ${b.remaining_pct}%`);
    if (b.total_pct     !== undefined) parts.push(`всего ${b.total_pct}%`);
    lines.push(`💰 <b>Бюджет:</b> ${parts.join(' · ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Данные будут обновлены';
}

// ── Claude system prompt ──────────────────────────────────────────────────────

function systemPrompt(data, firstName, extraNote) {
  const milestones = data.milestones.items
    .map(m => `${m.id} · ${m.title}: ${m.current ?? '—'} / ${m.target ?? '—'} ${m.unit || ''}`.trim())
    .join('\n');

  const userLine = firstName ? `Собеседник: ${firstName}. Обращайся по имени в ответах.` : '';

  return `Ты — Ассистент Bank ID, ИИ-помощник команды проекта Bank ID.
Твой Telegram-username: @psb_id_bot. Если спрашивают имя или username — отвечай именно это, без вариантов.
Работаешь в Telegram, помогаешь команде вести еженедельный дашборд и отвечаешь на вопросы по нему.
${userLine}

━━━ ФОРМАТИРОВАНИЕ ━━━
Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>, <code>код</code>
НЕ используй Markdown-звёздочки (**text**, *text*) — они не рендерятся.
Используй эмодзи для структуры. Пиши кратко и по делу.

━━━ ДАШБОРДЫ ━━━
Есть два дашборда, оба читают данные из GitHub в реальном времени:

📌 <b>Текущая неделя (WIP)</b>: https://bank-id-weekly-new.vercel.app
— Данные из data-new.json. Сюда вносятся обновления в течение недели через бота.
— Показывает только то, что уже внесено — пустые разделы скрыты.

📌 <b>Опубликованная неделя (факт)</b>: https://bank-id-weekly.vercel.app
— Данные из data.json. Финальный отчёт прошлой недели, не меняется.
— Каждый понедельник в 06:00 МСК данные из WIP автоматически становятся фактом.

━━━ КАК ФОРМИРОВАТЬ ДАШБОРД ━━━
Дашборд состоит из 3 разделов. По каждому нужно внести за неделю:

💰 <b>Бюджет</b> — исполнение бюджета проекта (в процентах, нарастающим итогом):
  · Обновить spent_pct (сколько % потрачено) и remaining_pct (сколько % осталось)

🎯 <b>Вехи</b> — прогресс к целям проекта (m1, m2, m3):
  · Обновить current (текущее значение) для нужной вехи по её id
  · target можно задать/поменять, если веха ещё не настроена

🧭 <b>Стримы</b> — по каждому направлению (IT, Интеграции, Партнёры, Оргстрим):
  · список сделанного за неделю
  · список артефактов

💡 <b>Советы по заполнению:</b>
· Заполняй по ходу недели, не откладывай на пятницу — бот всегда под рукой
· «Сделано» — конкретное действие (встреча, решение, отправка), не статус
· Артефакт — осязаемый результат: документ, ссылка, таблица, письмо
· Если артефакта нет — скажи «/skip», бот не будет переспрашивать

━━━ ТЕКУЩИЕ ДАННЫЕ (Н${data.meta.week}) ━━━
Бюджет: потрачено ${data.budget.spent_pct}% из ${data.budget.total_pct}%, остаток ${data.budget.remaining_pct}%

Вехи:
${milestones}

━━━ ОБНОВЛЕНИЕ ДАННЫХ ━━━
Данные НАКАПЛИВАЮТСЯ внутри недели:
· Массивы streams.<ключ>.done, streams.<ключ>.artifacts — пополняются
· Начинай новую запись с даты: "07.07 — текст"
· milestones.items[].current — обновляется (заменяется, не накапливается)
· Разные люди могут вносить данные по одному стриму в разные дни — всё сохранится

Когда пользователь хочет внести обновление:
1. Уточни если неясно — какой раздел, какой стрим или веха
2. Спроси про артефакт (если не упомянул). /skip — пропустить.
3. Верни патч в строгом формате:

PATCH:
\`\`\`json
{ patch object }
\`\`\`
CONFIRM: <что обновлено>

Примеры патчей:
· Стрим (добавить): { "streams": { "it": { "done": ["05.07 — Настроен доступ к тестовому контуру"], "artifacts": ["Инструкция по подключению"] } } }
· Стрим «Интеграции»: { "streams": { "integrations": { "done": ["05.07 — Проведена встреча с партнёром по API"] } } }
· Веха (обновить прогресс): { "milestones": { "items": [{ "id": "m1", "current": 120 }] } }
· Веха (настроить цель): { "milestones": { "items": [{ "id": "m2", "title": "Подключение банков-партнёров", "target": 5, "current": 0, "unit": "банков" }] } }
· Бюджет: { "budget": { "spent_pct": 30, "remaining_pct": 70 } }

━━━ РЕЖИМ ПРАВКИ ($set) ━━━
Если пользователь хочет ИСПРАВИТЬ (а не дополнить) уже записанный текст в стриме — используй флаг "$set": true на уровне стрима:
{ "streams": { "it": { "$set": true, "done": ["07.07 — исправленный текст"], "artifacts": ["Новый артефакт"] } } }
Это полностью заменит текущие массивы done/artifacts, а не дополнит их.
Используй $set когда: пользователь говорит «исправь», «замени», «перепиши», «правка», «было неверно».${extraNote ? '\n\n' + extraNote : ''}`;
}

// ── Apply patch to data ────────────────────────────────────────────────────────

function applyPatch(data, patch) {
  const d = JSON.parse(JSON.stringify(data));

  for (const [key, val] of Object.entries(patch)) {

    if (key === 'streams' && typeof val === 'object') {
      for (const [streamKey, streamPatch] of Object.entries(val)) {
        if (!d.streams[streamKey]) continue;
        const stream = d.streams[streamKey];
        const isSet = !!streamPatch['$set'];

        if (streamPatch.done) {
          stream.done = isSet
            ? [].concat(streamPatch.done)
            : [...(stream.done || []), ...[].concat(streamPatch.done)];
        }
        if (streamPatch.artifacts) {
          stream.artifacts = isSet
            ? [].concat(streamPatch.artifacts)
            : [...(stream.artifacts || []), ...[].concat(streamPatch.artifacts)];
        }
        for (const [f, v] of Object.entries(streamPatch)) {
          if (f !== 'done' && f !== 'artifacts' && f !== '$set') stream[f] = v;
        }
      }

    } else if (key === 'milestones' && typeof val === 'object') {
      if (val.items) {
        [].concat(val.items).forEach(patchItem => {
          const idx = d.milestones.items.findIndex(m => m.id === patchItem.id);
          if (idx < 0) return;
          Object.assign(d.milestones.items[idx], patchItem);
        });
      }

    } else if (key === 'budget' && typeof val === 'object') {
      if (!d.budget) d.budget = {};
      Object.assign(d.budget, val);

    } else if (typeof val === 'object' && !Array.isArray(val) && val !== null && typeof d[key] === 'object') {
      Object.assign(d[key], val);
    } else {
      d[key] = val;
    }
  }

  d.meta.updated = new Date().toISOString();
  return d;
}

// ── Main handler ──────────────────────────────────────────────────────────────

const SAVE_WORDS  = ['да', 'ок', 'ok', '+', '👍', 'yes', 'сохранить', 'ладно', 'записать', 'верно', 'правильно'];
const EDIT_WORDS  = ['изменить', 'нет', 'исправить', 'правка', 'отмена', 'cancel', 'edit', 'не то', 'неверно'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const msg = update?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId    = msg.chat.id;
  const userId    = String(msg.from?.id || '');
  const text      = msg.text || '';
  const firstName = msg.from?.first_name || '';
  const isGroup   = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const BOT_USERNAME = 'psb_id_bot';
  const BOT_ID       = 8997979249;

  if (isGroup) {
    const mentionsBot = text.toLowerCase().includes(`@${BOT_USERNAME}`) || text.toLowerCase().includes('ассистент');
    const replyToBot  = msg.reply_to_message?.from?.id === BOT_ID;
    if (!mentionsBot && !replyToBot) return res.status(200).json({ ok: true });
  }

  const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();

  // /msg <chat_id> <text> — admin-only: send a message to any chat the bot is in
  if (cleanText.startsWith('/msg ') && userId === '732508798') {
    const parts = cleanText.slice(5).match(/^(-?\d+)\s+([\s\S]+)$/);
    if (parts) {
      const [, targetChatId, msgText] = parts;
      if (!conversations[userId]) conversations[userId] = { messages: [], pendingPatch: null, editMode: false };
      conversations[userId].pendingMsg = { targetChatId, msgText };
      await saveState(conversations, stateSha);
      await tgSend(chatId,
        `📋 <b>Превью сообщения</b> → чат <code>${targetChatId}</code>:\n\n${msgText}\n\n` +
        `<i>Ответьте <b>да</b> — отправить, <b>нет</b> — отмена</i>`
      );
    } else {
      await tgSend(chatId, 'Формат: /msg &lt;chat_id&gt; &lt;текст&gt;');
    }
    return res.status(200).json({ ok: true });
  }

  // /id — show chat and user IDs (useful for setup)
  if (cleanText === '/id' || cleanText === '/chatid') {
    await tgSend(chatId, `🔍 <b>ID чата:</b> <code>${chatId}</code>\n👤 <b>Ваш user ID:</b> <code>${userId}</code>`);
    return res.status(200).json({ ok: true });
  }

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await tgSend(chatId, '⛔ Нет доступа.');
    return res.status(200).json({ ok: true });
  }

  const [stateResult, dataResult] = await Promise.all([getState(), getDataJson()]);
  const { conversations, sha: stateSha } = stateResult;
  const { data, sha: dataSha } = dataResult;

  if (!conversations[userId]) conversations[userId] = { messages: [], pendingPatch: null, editMode: false };
  const conv = conversations[userId];

  const lc = cleanText.toLowerCase().trim();

  // ── Handle pending /msg confirmation ─────────────────────────────────────
  if (conv.pendingMsg) {
    const isSave = SAVE_WORDS.some(w => lc === w);
    const isEdit = EDIT_WORDS.some(w => lc === w);
    if (isSave) {
      const { targetChatId, msgText } = conv.pendingMsg;
      conv.pendingMsg = null;
      await saveState(conversations, stateSha);
      await tgSend(targetChatId, msgText);
      await tgSend(chatId, '✅ Отправлено');
    } else if (isEdit) {
      conv.pendingMsg = null;
      await saveState(conversations, stateSha);
      await tgSend(chatId, '❌ Отменено');
    }
    return res.status(200).json({ ok: true });
  }

  // ── Handle pending confirmation ───────────────────────────────────────────
  if (conv.pendingPatch) {
    const isSave = SAVE_WORDS.some(w => lc === w);
    const isEdit = EDIT_WORDS.some(w => lc === w);

    if (isSave) {
      const { patch, confirmText } = conv.pendingPatch;
      const newData = applyPatch(data, patch);
      const ok = await putDataJson(newData, dataSha, `feat: update via bot — ${confirmText}`);
      conv.pendingPatch = null;
      conv.editMode = false;
      if (ok) {
        // Keep last 6 messages for context continuity
        conv.messages = conv.messages.slice(-6);
        await tgSend(chatId, `✅ ${confirmText}\n\n🔗 <a href="https://bank-id-weekly-new.vercel.app">Открыть дашборд (текущая неделя)</a>`);
      } else {
        await tgSend(chatId, '❌ Не удалось сохранить в GitHub. Попробуй ещё раз.');
      }
      await saveState(conversations, stateSha);
      return res.status(200).json({ ok: true });
    }

    if (isEdit) {
      conv.pendingPatch = null;
      conv.editMode = true;
      await tgSend(chatId, '✏️ Хорошо. Отправь исправленный текст — запишу его целиком, без добавления к старому.');
      await saveState(conversations, stateSha);
      return res.status(200).json({ ok: true });
    }

    // Unrelated message: clear pending and proceed as new request
    conv.pendingPatch = null;
  }

  // ── Add user message to history ───────────────────────────────────────────
  conv.messages.push({ role: 'user', content: cleanText || text });

  // Keep last 20 messages
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  // ── Call Claude ───────────────────────────────────────────────────────────
  const extraNote = conv.editMode
    ? '⚠️ РЕЖИМ ПРАВКИ АКТИВЕН: для следующего патча ОБЯЗАТЕЛЬНО используй "$set": true.'
    : null;

  let claudeReply = '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt(data, firstName, extraNote),
      messages: conv.messages,
    });
    claudeReply = response.content[0].text;
  } catch (err) {
    await tgSend(chatId, `❌ Ошибка Claude: ${err.message}`);
    return res.status(200).json({ ok: true });
  }

  // ── Process Claude response ───────────────────────────────────────────────
  const patchMatch   = claudeReply.match(/PATCH:\s*```json\s*([\s\S]+?)```/);
  const confirmMatch = claudeReply.match(/CONFIRM:\s*(.+)/);

  if (patchMatch) {
    try {
      const patch       = JSON.parse(patchMatch[1]);
      const confirmText = confirmMatch?.[1]?.trim() || 'Дашборд обновлён';

      // Store pending patch — don't save yet
      conv.pendingPatch = { patch, confirmText };
      conv.editMode     = false;

      // Add cleaned reply to history (without the raw PATCH block)
      const historyReply = confirmText;
      conv.messages.push({ role: 'assistant', content: historyReply });

      const preview = previewPatch(patch, data);
      await tgSend(chatId,
        `📋 <b>Проверьте перед сохранением:</b>\n\n${preview}\n\n` +
        `<i>Ответьте <b>да</b> — сохранить, <b>изменить</b> — скорректировать текст</i>`
      );
    } catch (err) {
      await tgSend(chatId, `❌ Ошибка при разборе патча: ${err.message}`);
    }
  } else {
    // Regular conversation — send Claude reply as-is
    conv.messages.push({ role: 'assistant', content: claudeReply });
    await tgSend(chatId, claudeReply);
  }

  await saveState(conversations, stateSha);
  return res.status(200).json({ ok: true });
}
