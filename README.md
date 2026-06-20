# SC4Free

**Неофициальный бесплатный клиент SoundCloud** для Windows/macOS/Linux.  
Десктопное приложение на Electron + React + Vite с офлайн-загрузкой треков, воспроизведением без рекламы и строгой архитектурой безопасности.

> Автор: [qveqa](https://github.com/qveqa)

---

## Возможности

| Функция | Описание |
|---------|----------|
| 🔊 Стриминг без рекламы | Прямые CDN-ссылки разрешаются в main process, минуя рекламные трекеры |
| 📥 Офлайн-загрузка | Progressive MP3 или HLS (через ffmpeg) → MP3 с ID3-тегами и обложкой |
| 🎵 Плейбар | Плавный seek-slider на Pointer Events без React ре-рендеров, поддержка shuffle/repeat |
| 🔑 Авторизация | Изолированный modal-браузер перехватывает `oauth_token` cookie; ручной ввод токена как fallback |
| 🏷 ID3-тегирование | Title, Artist, Album, Cover Art вшиваются в каждый скачанный MP3 |
| ⌨️ Медиаклавиши | Полная интеграция с Media Session API (кнопки на клавиатуре, наушниках, виджеты ОС) |
| 🗄 SQLite хранилище | WAL-режим, схема с миграциями, кэшированные prepared statements |
| 🔒 Безопасность | Sandbox renderer, safeStorage шифрование, whitelist хостов, защита от path traversal |
| 🔄 Crash recovery | Автоочистка `.temp` и сброс прерванных задач при запуске |

---

## Установка и запуск

### Требования

- **Node.js** v20+
- **C++ Build Tools**: Visual Studio Build Tools (Windows), Xcode CLI Tools (macOS), GCC/Make (Linux) — нужны для компиляции `better-sqlite3`

### Шаги

```bash
# 1. Клонировать репозиторий
git clone https://github.com/qveqa/sc4free
cd sc4free

# 2. Установить зависимости (автоматически пересоберёт sqlite3 для Electron)
npm install

# 3. Запустить в dev-режиме
npm run dev

# 4. Собрать production-установщик
npm run build
```

---

## Структура проекта

```
sc4free/
├── main.js              # Electron main process — IPC, auth, downloads, security
├── preload.js           # Context bridge — безопасный API между main и renderer
├── database.js          # SQLite layer с кэшированными prepared statements
├── run-dev.js           # Запускатель: Vite dev server + Electron
├── vite.config.js       # Конфигурация сборщика
├── index.html           # Точка входа рендерера (CSP, шрифты)
├── package.json         # Зависимости и скрипты
├── output/              # Папка скачанных треков (создаётся автоматически)
│   └── .temp/           # Временные файлы во время загрузки (очищается при запуске)
└── src/
    ├── main.jsx         # React root
    ├── App.jsx          # Корневой компонент: аудио-движок, очередь, состояние
    ├── index.css        # Design system, glassmorphism, компоненты
    └── components/
        ├── Playbar.jsx      # Нижний плейбар с DOM-slider без ре-рендеров
        ├── SearchTab.jsx    # Поиск и воспроизведение треков
        ├── DownloadsTab.jsx # Локальная библиотека
        ├── SettingsTab.jsx  # Настройки, авторизация, О программе
        └── Sidebar.jsx      # Навигация и профиль пользователя
```

---

## Архитектура IPC

Renderer **не имеет прямого доступа к Node.js**. Всё общение идёт через `contextBridge`:

```
Renderer (React) ──→ preload.js (contextBridge) ──→ main.js (ipcMain)
                                                         │
                    ┌────────────────────────────────────┤
                    │  HTTP (axios, whitelist only)       │
                    │  SQLite (better-sqlite3)            │
                    │  Filesystem (download dir only)     │
                    │  safeStorage (token encryption)     │
                    └────────────────────────────────────┘
```

### Доступные IPC каналы

| Канал | Тип | Описание |
|-------|-----|----------|
| `get-settings` | handle | Получить все настройки |
| `save-settings` | handle | Сохранить изменённые настройки |
| `select-download-dir` | handle | Выбрать папку через системный диалог |
| `search-tracks` | handle | Поиск треков (кэш 5 мин, whitelist хостов) |
| `get-track-stream` | handle | Разрешить CDN URL для воспроизведения |
| `download-track` | on (fire & forget) | Добавить трек в очередь загрузки |
| `get-downloads` | handle | Список скачанных треков (с проверкой файлов) |
| `delete-download` | handle | Удалить трек и файлы с диска |
| `get-download-tasks` | handle | Список активных задач загрузки |
| `delete-download-task` | handle | Удалить задачу из очереди |
| `open-auth-window` | handle | Открыть modal-браузер авторизации |
| `logout` | handle | Удалить токен и выйти |
| `get-auth-profile` | handle | Получить профиль по сохранённому токену |
| `save-manual-token` | handle | Сохранить и проверить токен вручную |
| `open-external` | handle | Открыть whitelisted URL в браузере |
| `download-progress` | send (main→renderer) | Прогресс загрузки треков |
| `auth-status` | send (main→renderer) | Статус авторизации |

---

## Хранение данных

### SQLite (userData/soundcloud_client.db)

| Таблица | Содержимое |
|---------|------------|
| `tracks` | Скачанные треки: id, title, artist, fileName, coverName, duration, downloadedAt |
| `settings` | Настройки приложения: volume, repeatMode, shuffleMode, downloadDirectory, windowSize |
| `auth` | Зашифрованный OAuth токен (BLOB через safeStorage) |
| `download_tasks` | Активные/завершённые задачи загрузки со статусом и прогрессом |
| `app_meta` | Версия схемы БД |

### Файловая система

- **Треки**: `output/<Артист> - <Название>.mp3`
- **Обложки**: `output/<Артист> - <Название>.jpg`
- **Временные файлы**: `output/.temp/<trackId>.tmp.mp3` (удаляются при старте и по завершению)
- **Кэш client_id**: `userData/client-id-cache.json` (обновляется раз в 3–7 дней)

### Шифрование токенов

Токены хранятся через `Electron.safeStorage`:
- **Windows**: DPAPI (Data Protection API)
- **macOS**: Keychain
- **Linux**: libsecret / kwallet

---

## Авторизация

SC4Free поддерживает два способа входа:

### 1. Вход через браузер (рекомендуется)
Открывается изолированный BrowserWindow без nodeIntegration → загружается `soundcloud.com/signin` → после входа перехватывается cookie `oauth_token` → сохраняется зашифрованным → окно закрывается.

### 2. Ручной ввод токена (Advanced Mode)
В Настройках → раздел "Аккаунт" → "Ввод куки вручную". Нужно скопировать значение cookie `oauth_token` из DevTools браузера на soundcloud.com.

---

## Загрузки

Очередь загрузок обрабатывается параллельно (до 4 одновременно):

1. **Загрузка обложки** — через Axios, сохраняется во временную папку
2. **Разрешение stream URL** — main process делает запрос к API SoundCloud
3. **Скачивание аудио**:
   - **Progressive MP3**: Axios stream → файл
   - **HLS**: ffmpeg напрямую декодирует `.m3u8` → MP3
4. **Проверка целостности** — размер файла должен быть > 100 КБ
5. **ID3-тегирование** — Title, Artist, Album="SoundCloud", Cover Art
6. **Атомарное перемещение** — tmp → output (с fallback copy+unlink при cross-device)
7. **Запись в БД** и уведомление UI

---

## Безопасность

| Механизм | Детали |
|----------|--------|
| Renderer Sandbox | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| IPC Whitelist | Renderer может вызывать только задокументированные каналы через preload |
| URL Whitelist | Все HTTP-запросы проходят через `validateUrl()` — whitelist доменов SoundCloud/sndcdn.com |
| Path Traversal | `media://` протокол ограничен строго папкой downloads (case-insensitive на Windows) |
| Filename Sanitization | `sanitizeFilename()` удаляет запрещённые символы FS, ограничивает длину до 180 символов |
| Token Encryption | `safeStorage.encryptString()` — AES-256 с ключом из хранилища ОС |
| Navigation Guard | `will-navigate` блокирует любые навигации не на localhost |
| Window Open Guard | `setWindowOpenHandler` запрещает создание новых окон из renderer |
| open-external Guard | Только whitelisted URLs могут быть открыты в браузере |

---

## Troubleshooting

### Приложение не запускается
- Убедитесь, что `npm install` завершился без ошибок (особенно сборка `better-sqlite3`)
- На Windows нужен **Visual Studio Build Tools** с компонентом "Desktop development with C++"
- Попробуйте `npm install --verbose` для детального лога

### Поиск не работает / ошибка "Ошибка поиска"
- Проверьте подключение к интернету
- Кэш `client_id` мог устареть: удалите файл `%APPDATA%\sc4free\client-id-cache.json` и перезапустите
- Если ошибка 401/403 — войдите в аккаунт SoundCloud через Настройки

### Загрузка зависает или обрывается
- Проверьте наличие места на диске
- Если трек скачивался через HLS — убедитесь, что `ffmpeg-static` установлен корректно
- Прерванные загрузки автоматически сбрасываются при следующем запуске

### Нет звука при воспроизведении
- Треки требуют авторизованного `oauth_token` для получения stream URL
- Попробуйте войти в аккаунт в Настройках

### Большой файл базы данных
- База данных в WAL-режиме — нормально иметь `.db-wal` и `.db-shm` файлы рядом
- Они объединяются автоматически при закрытии приложения

---

## Известные ограничения

| Ограничение | Причина |
|-------------|---------|
| Работает только с публичными треками или треками из авторизованного аккаунта | SoundCloud API требует токен для приватного контента |
| `client_id` может устаревать | SoundCloud периодически меняет client_id в JS-бандлах; скрейпер обновляет его автоматически |
| HLS-загрузки медленнее progressive | ffmpeg должен объединить все сегменты `.m3u8` |
| Воспроизведение HLS онлайн не поддерживается | HTML5 `<audio>` не поддерживает HLS без MSE; только CDN-стримы воспроизводятся напрямую |
| Нет плейлистов | Не реализовано — работа только с треками из поиска и локальной библиотеки |
| Нет лайков / feed | Не реализовано в текущей версии |
| Windows MAX_PATH (260 символов) | Имена файлов ограничены 180 символами; очень длинные названия усекаются |

---

## Лицензия

MIT © [qveqa](https://github.com/qveqa)
