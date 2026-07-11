# Bank ID · Еженедельный дашборд

Система еженедельной отчётности для команды проекта Bank ID — дашборд + Telegram-бот для ввода данных. Данные хранятся в GitHub, дашборд деплоится на Vercel, бот работает как Vercel Serverless Function.

---

## Архитектура

```
Telegram-бот (@BOT_USERNAME_PLACEHOLDER)
    │  пишет через GitHub Contents API
    ▼
GitHub репозиторий
    ├── data-new.json   ← текущая неделя (WIP, редактируется)
    ├── data.json       ← опубликованная неделя (факт, только чтение)
    ├── archive/        ← архив по неделям (week-01.json, …)
    ├── state.json      ← состояние диалогов бота
    └── index.html      ← весь фронтенд (один файл)
         │
         │  читает через raw.githubusercontent.com
         ▼
Vercel (два деплоя из одного репо)
    ├── bank-id-weekly.vercel.app       → data.json    (опубликованный факт)
    └── bank-id-weekly-new.vercel.app   → data-new.json (WIP текущей недели)

GitHub Actions (каждый понедельник 06:00 МСК)
    └── weekly-publish.yml → архивирует, продвигает WIP в факт, генерирует шаблон след. недели
```

**Ключевой принцип:** данные живут в GitHub, дашборд — статический HTML без бэкенда. Vercel нужен только для хостинга HTML и для webhook-функции бота.

---

## Структура файлов

```
├── index.html                  # Весь фронтенд — один файл, читает JSON с GitHub
├── data.json                   # Опубликованные данные текущей недели
├── data-new.json               # WIP-данные (заполняется через бота)
├── state.json                  # Состояние диалогов бота (авто, не редактировать)
├── og.png                      # OG-превью для соцсетей / мессенджеров
├── package.json                # Зависимость: @anthropic-ai/sdk
├── vercel.json                 # Настройки Vercel (rewrites + функция бота)
├── api/
│   └── webhook.js              # Telegram webhook → Claude Haiku → GitHub API
├── archive/
│   └── week-NN.json            # Архив опубликованных недель
└── .github/
    └── workflows/
        └── weekly-publish.yml  # Еженедельная публикация
```

---

## Разделы дашборда

| # | Раздел | Ключ в JSON | Описание |
|---|--------|-------------|----------|
| 1 | 💰 Бюджет | `budget` | Исполнение бюджета проекта в процентах, нарастающим итогом |
| 2 | 🎯 Вехи | `milestones` | Ключевые цели проекта и прогресс к ним (текущее / целевое значение) |
| 3 | 🧭 Стримы | `streams` | Направления работы проекта: IT, Интеграции, Партнёры, Оргстрим |

---

## Структура data.json / data-new.json

```jsonc
{
  "meta": { "week": 1, "date": "13 июля 2026", "updated": "..." },

  "budget": {
    "total_pct": 100,
    "spent_pct": 25,
    "remaining_pct": 75
  },

  "milestones": {
    "items": [
      { "id": "m1", "title": "1000 пользователей", "target": 1000, "current": 120, "unit": "пользователей" },
      { "id": "m2", "title": "Веха 2", "target": null, "current": null, "unit": "" },
      { "id": "m3", "title": "Веха 3", "target": null, "current": null, "unit": "" }
    ]
  },

  "streams": {
    "it":           { "title": "IT", "done": ["07.07 — ..."], "artifacts": ["..."] },
    "integrations": { "title": "Интеграции", "done": [], "artifacts": [] },
    "partners":     { "title": "Партнёры", "done": [], "artifacts": [] },
    "org":          { "title": "Организационный стрим", "done": [], "artifacts": [] }
  }
}
```

Если у вехи `target` не задан (`null`) — на дашборде карточка вехи показывается как «Не настроена», а не как 0%.

### Правила накопления данных

| Поле | Поведение |
|------|-----------|
| `streams.<ключ>.done`, `streams.<ключ>.artifacts` | Массивы — пополняются в течение недели, очищаются при публикации |
| `milestones.items[].current` | Обновляется (заменяется, не накапливается) — прогресс нарастающим итогом |
| `budget.*` | Проценты нарастающим итогом — не сбрасываются при публикации |

---

## Еженедельный workflow (GitHub Actions)

Запускается каждый **понедельник в 06:00 МСК** (или вручную через `workflow_dispatch`).

**Шаги:**

1. **Guard** — пропускает, если `data-new.week <= data.week` (защита от двойной публикации)
2. **Архив** — сохраняет `data.json` → `archive/week-NN.json`
3. **Продвижение** — `data-new.json` → `data.json`
4. **Новый шаблон** — генерирует `data-new.json` для следующей недели:
   - `streams.<ключ>.done` и `streams.<ключ>.artifacts` очищаются
   - `milestones` не трогается (текущее состояние сохраняется как есть)
   - `budget` не трогается (нарастающий итог)

---

## Telegram-бот (@BOT_USERNAME_PLACEHOLDER)

**Стек:** Vercel Serverless Function → Claude Haiku → GitHub Contents API

### Команды

| Команда | Кто | Описание |
|---------|-----|----------|
| `/id` | все | Показывает `chat_id` и `user_id` текущего чата |
| `/msg <chat_id> <текст>` | только admin | Отправляет сообщение в указанный чат (с превью и подтверждением) |

### Флоу добавления данных

```
Оператор пишет боту
    │
    ▼
Claude Haiku уточняет раздел/стрим/веху, спрашивает артефакт
    │
    ▼
Бот показывает превью: «📋 Проверьте перед сохранением»
    │
  да │ изменить
    │         └─→ «Отправь исправленный текст» (режим $set — замена вместо дописывания)
    ▼
GitHub Contents API обновляет data-new.json
    │
    ▼
Vercel CDN раздаёт обновлённый дашборд
```

### Режим правки ($set)

Если нужно **заменить** (а не дописать) уже записанный текст в стриме — сказать боту «исправь», «замени», «перепиши». Следующий патч использует `$set: true` и перезаписывает массивы `done`/`artifacts` целиком.

### Контекст диалога

- Хранится в `state.json` в репозитории
- Последние **20 сообщений** на пользователя
- После успешного сохранения остаются **6 сообщений** (не сбрасывается в 0)

---

## Переменные окружения (Vercel)

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_TOKEN` | Токен бота от @BotFather |
| `ANTHROPIC_API_KEY` | Ключ Anthropic API |
| `GITHUB_TOKEN` | Personal Access Token с правом `Contents: write` на репо |
| `ALLOWED_TELEGRAM_IDS` | Comma-separated список user_id, которым разрешён доступ к боту (пусто = все) |

---

## Два деплоя из одного репо

Дашборд определяет, какой файл читать, по hostname:

```javascript
const IS_NEW = window.location.hostname.includes('-new') ||
               window.location.search.includes('new=1');
const file = IS_NEW ? 'data-new.json' : 'data.json';
```

Оба деплоя — один и тот же `index.html`, только данные разные.

**Настройка доменов как постоянных production-алиасов:**
```bash
vercel domains add bank-id-weekly.vercel.app
vercel domains add bank-id-weekly-new.vercel.app
```

---

## Как развернуть копию для другого проекта

1. **Fork репозитория** или скопировать файлы в новый репо
2. **Создать Telegram-бота** через @BotFather → получить токен, username и numeric id, подставить в `api/webhook.js` (`BOT_USERNAME`, `BOT_ID`)
3. **Создать GitHub PAT**: Settings → Developer settings → Personal access tokens → `Contents: write` на новый репо
4. **Создать проект в Vercel**: импортировать репо, добавить переменные окружения
5. **Настроить webhook** Telegram:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<vercel-domain>/api/webhook
   ```
6. **Создать второй Vercel-деплой** (тот же репо, другое имя проекта) — для `-new` версии
7. **Адаптировать данные**: отредактировать `data.json` и `data-new.json` под новый проект — разделы, вехи, стримы
8. **Обновить системный промпт бота** в `api/webhook.js` — название проекта, логику разделов
9. **Запустить первый GitHub Action** вручную (`workflow_dispatch`) чтобы проверить публикацию

---

## Коллабораторы

| GitHub | Роль |
|--------|------|
| @sharnenkov | Owner |
