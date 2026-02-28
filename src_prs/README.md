# Telegram Parser v2.0.0

Профессиональный парсер Telegram-каналов с поддержкой вебхуков и rate limiting.

## 🚀 Быстрый старт

### Требования
- Node.js 22+
- Docker & Docker Compose (для продакшена)

### Локальная установка
```bash
# Клонирование репозитория
git clone <repository-url>
cd telegram-parser

# Установка зависимостей
npm install

# Настройка переменных окружения
cp .env.example .env
# Отредактируйте .env файл

# Запуск
npm start
```

### Docker развертывание
```bash
# Сборка и запуск
docker-compose up -d

# Просмотр логов
docker-compose logs -f
```

## 📋 API Endpoints

### Основные
- `GET /status` - Статус сервера
- `GET /get-dialogs` - Список диалогов
- `GET /get-messages` - Сообщения канала
- `GET /get-comments` - Комментарии к сообщению

### Мониторинг
- `POST /monitor/set-webhook` - Установка глобального webhook
- `POST /monitor/add` - Добавление канала в мониторинг
- `GET /monitor/list` - Список мониторируемых каналов

## 🔧 Конфигурация

### Переменные окружения
```env
API_ID=your_telegram_api_id
API_HASH=your_telegram_api_hash
SESSION=your_telegram_session_string
WEBHOOK_GLOBAL_URL=https://your-domain.com/webhook
PORT=3005
NODE_ENV=production
```

### monitored-channels.json
```json
{
  "globalWebhookUrl": "https://p.botstroicom.site/webhook",
  "channels": [
    {
      "id": "1467139881",
      "name": "Channel Name",
      "watchMessages": true,
      "watchComments": false,
      "watchReactions": false,
      "topicIds": [],
      "linkedTo": null,
      "addedAt": "2025-02-28T12:00:00.000Z"
    }
  ]
}
```

## 🏗️ Архитектура

- **Rate Limiting**: 20 запросов/сек с очередью
- **Webhook система**: Автоматическая отправка уведомлений
- **Мониторинг**: Отслеживание сообщений, комментариев, реакций
- **Безопасность**: Изоляция в Docker контейнере

## 📊 Мониторинг

### Health Check
```bash
curl http://localhost:3005/status
```

### Логи
```bash
# Docker logs
docker-compose logs telegram-parser

# Application logs
docker exec telegram-parser tail -f /app/logs/app.log
```

## 🔗 Интеграции

### N8N
Создайте webhook endpoint в N8N для получения уведомлений от парсера.

### Supabase
Используйте Supabase для хранения сообщений и медиафайлов.

## 🛠️ Разработка

```bash
# Development mode
npm run dev

# Production build
npm run build

# PM2 deployment
npm run pm2
```

## 📝 Лицензия

MIT License - см. файл LICENSE для деталей.

## 🤝 Поддержка

При проблемах проверьте логи и статус health check.