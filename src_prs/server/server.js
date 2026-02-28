const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ==========================================
// КОНФИГУРАЦИЯ
// ==========================================

const CONFIG = {
  PORT: 3005,
  TELEGRAM_RATE_LIMIT: 20, // запросов в секунду
  QUEUE_MAX_SIZE: 1000,   // максимальный размер очереди
  REQUEST_TIMEOUT: 30000, // таймаут запроса (30 сек)
  MAX_RETRIES: 3,         // максимум повторных попыток
};

// Глобальные переменные
const app = express();
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION);

// ==========================================
// RATE LIMITING СИСТЕМА
// ==========================================

class RateLimiter {
  constructor(requestsPerSecond) {
    this.requestsPerSecond = requestsPerSecond;
    this.requests = [];
    this.queue = [];
    this.isProcessing = false;
  }

  // Добавление запроса в очередь
  async enqueue(requestFn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= CONFIG.QUEUE_MAX_SIZE) {
        reject(new Error('Queue is full'));
        return;
      }

      this.queue.push({ requestFn, resolve, reject });
      this.processQueue();
    });
  }

  // Обработка очереди
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Проверка rate limit
      await this.waitForRateLimit();

      const { requestFn, resolve, reject } = this.queue.shift();

      try {
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessing = false;
  }

  // Ожидание соблюдения rate limit
  async waitForRateLimit() {
    const now = Date.now();

    // Очистка старых запросов (старше 1 секунды)
    this.requests = this.requests.filter(time => now - time < 1000);

    // Если достигли лимита - ждем
    if (this.requests.length >= this.requestsPerSecond) {
      const oldestRequest = Math.min(...this.requests);
      const waitTime = 1000 - (now - oldestRequest);

      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // Регистрация нового запроса
    this.requests.push(now);
  }

  // Получение статуса
  getStatus() {
    return {
      queueLength: this.queue.length,
      requestsInLastSecond: this.requests.length,
      isProcessing: this.isProcessing
    };
  }
}

// Глобальный rate limiter
const rateLimiter = new RateLimiter(CONFIG.TELEGRAM_RATE_LIMIT);

// ==========================================
// ТЕЛЕГРАМ КЛИЕНТ МЕНЕДЖЕР
// ==========================================

class TelegramManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async getClient() {
    if (!this.client) {
      this.client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: CONFIG.MAX_RETRIES,
      });
    }

    if (!this.isConnected) {
      await this.client.start();
      this.isConnected = true;
      console.log('Telegram client connected');
    }

    return this.client;
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
      console.log('Telegram client disconnected');
    }
  }
}

const telegramManager = new TelegramManager();

// ==========================================
// УНИВЕРСАЛЬНЫЕ МЕТОДЫ ПОЛУЧЕНИЯ КОНТЕНТА
// ==========================================

class ContentManager {
  constructor() {
    this.telegramManager = telegramManager;
  }

  // Получение всех диалогов (каналы + группы + пользователи)
  async getDialogs() {
    return await rateLimiter.enqueue(async () => {
      const client = await this.telegramManager.getClient();
      const dialogs = await client.getDialogs();

      return dialogs.map(dialog => ({
        id: dialog.entity.id,
        accessHash: dialog.entity.accessHash,
        title: dialog.entity.title,
        type: dialog.entity.className.toLowerCase(), // channel, chat, user
        participants: dialog.entity.participantsCount || null,
        username: dialog.entity.username || null,
      }));
    });
  }

  // Получение сообщений из любого типа чата
  async getMessages(entityId, options = {}) {
    return await rateLimiter.enqueue(async () => {
      const client = await this.telegramManager.getClient();
      const dialogs = await client.getDialogs();

      // Поиск диалога по ID или username
      const dialog = dialogs.find(d =>
        d.entity.id.toString() === entityId.toString() ||
        (d.entity.username && d.entity.username === entityId)
      );

      if (!dialog) {
        throw new Error(`Dialog ${entityId} not found`);
      }

      const entity = dialog.entity;
      const messages = await client.getMessages(entity, {
        limit: options.limit || 10,
        offsetId: options.offsetId || 0,
        offsetDate: options.offsetDate ? Math.floor(new Date(options.offsetDate).getTime() / 1000) : undefined,
      });

      return {
        dialog: {
          id: entity.id,
          title: entity.title,
          type: entity.className.toLowerCase(),
          username: entity.username,
        },
        messages: messages.map(msg => ({
          id: msg.id,
          text: msg.message,
          date: msg.date,
          senderId: msg.senderId,
          views: msg.views || 0,
          forwards: msg.forwards || 0,
          media: msg.media ? true : false,
          replyToId: msg.replyTo?.replyToMsgId || null,
          reactions: msg.reactions ? msg.reactions.results : [],
        })),
        nextOffsetId: messages.length > 0 ? messages[messages.length - 1].id : null,
      };
    });
  }

  // Получение комментариев (если поддерживается)
  async getComments(channelId, messageId, options = {}) {
    return await rateLimiter.enqueue(async () => {
      const client = await this.telegramManager.getClient();

      try {
        // Попытка получить комментарии к сообщению
        const comments = await client.getComments(channelId, messageId, {
          limit: options.limit || 50,
        });

        return comments.map(comment => ({
          id: comment.id,
          text: comment.message,
          date: comment.date,
          senderId: comment.senderId,
          replyToId: comment.replyTo?.replyToMsgId || null,
        }));
      } catch (error) {
        // Если комментарии не поддерживаются
        return [];
      }
    });
  }

  // Получение медиа файлов (ссылки)
  async getMedia(messageId, chatId) {
    return await rateLimiter.enqueue(async () => {
      const client = await this.telegramManager.getClient();

      try {
        const message = await client.getMessages(chatId, { ids: [messageId] });

        if (!message[0]?.media) {
          return null;
        }

        // Получение ссылки на скачивание
        const buffer = await client.downloadMedia(message[0].media, {});

        return {
          type: message[0].media.className,
          size: buffer.length,
          // В реальном приложении здесь была бы ссылка для скачивания
          downloadUrl: `/download/${messageId}`,
        };
      } catch (error) {
        console.error('Error getting media:', error);
        return null;
      }
    });
  }
}

const contentManager = new ContentManager();

// ==========================================
// WEBHOOK МЕНЕДЖЕР
// ==========================================

class WebhookManager {
  constructor() {
    this.webhooks = new Map(); // channelId -> webhookUrl
  }

  registerWebhook(channelId, webhookUrl) {
    this.webhooks.set(channelId, webhookUrl);
    console.log(`Webhook registered for channel ${channelId}: ${webhookUrl}`);
  }

  unregisterWebhook(channelId) {
    this.webhooks.delete(channelId);
    console.log(`Webhook unregistered for channel ${channelId}`);
  }

  getWebhook(channelId) {
    return this.webhooks.get(channelId);
  }

  async sendWebhook(channelId, data) {
    const webhookUrl = this.getWebhook(channelId);
    if (!webhookUrl) return;

    try {
      const https = require('https');
      const http = require('http');
      const url = new URL(webhookUrl);

      const postData = JSON.stringify({
        channelId,
        timestamp: new Date().toISOString(),
        ...data
      });

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Telegram-Parser-Webhook/1.0'
        }
      };

      const req = (url.protocol === 'https:' ? https : http).request(options);

      req.on('error', (error) => {
        console.error(`Webhook error for ${channelId}:`, error.message);
      });

      req.write(postData);
      req.end();

      console.log(`Webhook sent to ${channelId}`);
    } catch (error) {
      console.error(`Failed to send webhook for ${channelId}:`, error.message);
    }
  }
}

const webhookManager = new WebhookManager();

// ==========================================
// МОНИТОРИНГ КАНАЛОВ
// ==========================================

class ChannelMonitor {
  constructor(configPath = './monitored-channels.json') {
    this.configPath = configPath;
    this.config = {
      globalWebhookUrl: '',
      channels: []
    };
    this.channelsMap = new Map(); // channelId -> channel config
    this.eventHandlerInitialized = false;
  }

  // Загрузка конфигурации из файла
  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(data);
      
      // Построить Map для быстрого доступа
      this.channelsMap.clear();
      this.config.channels.forEach(channel => {
        this.channelsMap.set(channel.id.toString(), channel);
      });
      
      console.log(`✅ Loaded ${this.config.channels.length} channels from config`);
      return this.config;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Файл не существует - создать пустую конфигурацию
        console.log('⚠️  Config file not found, creating new one');
        await this.saveConfig();
        return this.config;
      }
      throw error;
    }
  }

  // Сохранение конфигурации в файл
  async saveConfig() {
    try {
      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf8'
      );
      console.log('✅ Config saved');
    } catch (error) {
      console.error('❌ Failed to save config:', error);
      throw error;
    }
  }

  // Добавление канала в мониторинг
  async addChannel(channelId, options = {}) {
    const channelIdStr = channelId.toString();
    
    const channelConfig = {
      id: channelIdStr,
      name: options.name || `Channel ${channelIdStr}`,
      watchMessages: options.watchMessages !== false, // по умолчанию true
      watchComments: options.watchComments || false,
      watchReactions: options.watchReactions || false,
      topicIds: options.topicIds || [], // массив: ["all"], ["general"], [512, 514], ["general", 512]
      linkedTo: options.linkedTo || null, // ID канала, к которому привязана эта группа
      addedAt: new Date().toISOString()
    };

    // Проверка, не добавлен ли уже
    const existingIndex = this.config.channels.findIndex(c => c.id === channelIdStr);
    
    if (existingIndex >= 0) {
      // Обновить существующий
      this.config.channels[existingIndex] = { ...this.config.channels[existingIndex], ...channelConfig };
    } else {
      // Добавить новый
      this.config.channels.push(channelConfig);
    }

    this.channelsMap.set(channelIdStr, channelConfig);
    await this.saveConfig();
    
    console.log(`✅ Channel ${channelIdStr} added to monitoring`);
    return channelConfig;
  }

  // Удаление канала из мониторинга
  async removeChannel(channelId) {
    const channelIdStr = channelId.toString();
    
    this.config.channels = this.config.channels.filter(c => c.id !== channelIdStr);
    this.channelsMap.delete(channelIdStr);
    
    await this.saveConfig();
    console.log(`✅ Channel ${channelIdStr} removed from monitoring`);
  }

  // Проверка, мониторится ли канал
  isMonitored(channelId) {
    return this.channelsMap.has(channelId.toString());
  }

  // Получение конфигурации канала
  getChannelConfig(channelId) {
    return this.channelsMap.get(channelId.toString());
  }

  // Получение всех мониторируемых каналов
  getMonitoredChannels() {
    return this.config.channels;
  }

  // Установка глобального webhook URL
  async setGlobalWebhookUrl(url) {
    this.config.globalWebhookUrl = url;
    await this.saveConfig();
    console.log(`✅ Global webhook URL set to: ${url}`);
  }

  // Получение глобального webhook URL
  getGlobalWebhookUrl() {
    return this.config.globalWebhookUrl;
  }
}

const channelMonitor = new ChannelMonitor();

// ==========================================
// EVENT HANDLERS - Автоматическое отслеживание
// ==========================================

async function initializeEventHandlers() {
  if (channelMonitor.eventHandlerInitialized) {
    console.log('⚠️  Event handlers already initialized');
    return;
  }

  try {
    const client = await telegramManager.getClient();
    const { NewMessage } = require('telegram/events');

    // Обработчик новых сообщений
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        // Получить ID чата/канала
        let chatId = message.chatId?.toString() || message.peerId?.channelId?.toString();
        if (!chatId) {
          chatId = message.peerId?.chatId?.toString();
        }
        if (!chatId) return;

        // Для каналов ID приходит с префиксом -100, нужно нормализовать
        // Канал: -1001467139881 -> проверяем как 1467139881 и -1001467139881
        const normalizedId = chatId.replace(/^-100/, '');


        // Проверить, мониторится ли канал (пробуем оба варианта)
        let channelConfig = channelMonitor.getChannelConfig(chatId);
        if (!channelConfig) {
          channelConfig = channelMonitor.getChannelConfig(normalizedId);
          if (channelConfig) {
            chatId = normalizedId; // Используем нормализованный ID
          }
        }
        
        if (!channelConfig) return; // Канал не мониторится

        // Проверка topicId для супергрупп с темами
        // Когда forumTopic=true, ID топика находится в replyToMsgId (ID первого сообщения топика)
        const messageTopicId = message.replyTo?.forumTopic ? message.replyTo.replyToMsgId : null;
        
        // Проверка фильтра по топикам
        const topicIds = channelConfig.topicIds || [];
        let topicMatch = true; // по умолчанию пропускаем (обратная совместимость)
        
        if (topicIds.length > 0) {
          if (topicIds.includes('all')) {
            // ["all"] - пропускаем все топики
            topicMatch = true;
          } else {
            // Проверяем конкретные топики
            // "general" означает null (сообщения без топика)
            // числа - конкретные ID топиков
            topicMatch = topicIds.some(tid => {
              if (tid === 'general') {
                return messageTopicId === null;
              }
              return tid === messageTopicId;
            });
          }
        }
        
        if (!topicMatch) {
          return; // Это сообщение из другой темы - игнорируем
        }

        // Определить тип события: обычное сообщение или комментарий
        // НЕ считаем комментарием, если это сообщение в топике (forumTopic: true)
        const isComment = (message.replyTo?.replyToMsgId && !message.replyTo?.forumTopic) ? true : false;
        
        // Проверить настройки для данного типа события
        if (isComment && !channelConfig.watchComments) {
          return; // Комментарии отключены для этого канала
        }
        
        if (!isComment && !channelConfig.watchMessages) {
          return; // Новые сообщения отключены для этого канала
        }

        const eventType = isComment ? 'new_comment' : 'new_message';
        const icon = isComment ? '💬' : '📩';
        
        // Получить информацию о канале (может быть undefined для некоторых типов чатов)
        let chat = null;
        let chatTitle = 'Unknown';
        try {
          chat = await message.getChat();
          chatTitle = chat?.title || chat?.firstName || 'Unknown';
        } catch (error) {
          console.warn(`Could not get chat info for ${chatId}`);
        }
        
        console.log(`${icon} ${eventType} in ${chatTitle} (${chatId}): ${message.id}`);

        // Подготовить данные для webhook
        const webhookData = {
          eventType,
          channelId: chatId,
          channelTitle: chatTitle,
          topicId: messageTopicId,
          linkedTo: channelConfig.linkedTo || null,
          message: {
            id: message.id,
            text: message.message || '',
            date: message.date,
            senderId: message.senderId?.toString(),
            senderUsername: null, // будет заполнено ниже если возможно
            views: message.views || 0,
            forwards: message.forwards || 0,
            media: message.media ? true : false,
            mediaType: message.media?.className || null,
            replyToId: message.replyTo?.replyToMsgId || null,
            reactions: message.reactions ? message.reactions.results : [],
            isComment
          }
        };

        // Попытка получить username отправителя
        try {
          const sender = await message.getSender();
          if (sender) {
            webhookData.message.senderUsername = sender.username || null;
            webhookData.message.senderFirstName = sender.firstName || null;
            webhookData.message.senderLastName = sender.lastName || null;
          }
        } catch (error) {
          // Игнорируем ошибки получения отправителя
        }

        // Отправить в webhook (неблокирующий)
        const webhookUrl = channelMonitor.getGlobalWebhookUrl();
        if (webhookUrl) {
          sendToWebhook(webhookUrl, webhookData).catch(error => {
            console.error(`⚠️  Webhook error for ${chatId}: ${error.message}`);
          });
        } else {
          console.log('⚠️  No global webhook URL configured');
        }

      } catch (error) {
        console.error('Error handling new message:', error.message);
      }
    }, new NewMessage({}));

    // Обработчик редактирования сообщений (для реакций)
    // ПРИМЕЧАНИЕ: MessageEdited недоступен в текущей версии библиотеки telegram
    // Обработка реакций временно отключена
    // TODO: Добавить поддержку при обновлении библиотеки
    /*
    try {
      const { MessageEdited } = require('telegram/events');
      
      client.addEventHandler(async (event) => {
        try {
          const message = event.message;
          if (!message) return;

          const chatId = message.chatId?.toString() || message.peerId?.channelId?.toString();
          if (!chatId) return;

          const channelConfig = channelMonitor.getChannelConfig(chatId);
          if (!channelConfig) return;

          // Проверка реакций
          if (channelConfig.watchReactions && message.reactions) {
            const chat = await message.getChat();
            
            console.log(`👍 Reactions updated in ${chat.title || chatId}: message ${message.id}`);

            const webhookData = {
              eventType: 'reactions_updated',
              channelId: chatId,
              channelTitle: chat.title || 'Unknown',
              message: {
                id: message.id,
                reactions: message.reactions.results
              }
            };

            const webhookUrl = channelMonitor.getGlobalWebhookUrl();
            if (webhookUrl) {
              await sendToWebhook(webhookUrl, webhookData);
            }
          }

        } catch (error) {
          console.error('Error handling message edit:', error);
        }
      }, new MessageEdited({}));
    } catch (error) {
      console.warn('⚠️  MessageEdited event not available in current telegram library version');
    }
    */

    channelMonitor.eventHandlerInitialized = true;
    console.log('✅ Event handlers initialized successfully');

  } catch (error) {
    console.error('❌ Failed to initialize event handlers:', error);
    throw error;
  }
}

// Универсальная функция отправки в webhook
async function sendToWebhook(webhookUrl, data) {
  try {
    const https = require('https');
    const http = require('http');
    const url = new URL(webhookUrl);

    const postData = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...data
    });

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Telegram-Parser-Monitor/2.0'
      },
      timeout: 10000
    };

    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ Webhook sent successfully (${res.statusCode})`);
            resolve(responseData);
          } else {
            console.error(`⚠️  Webhook returned status ${res.statusCode}`);
            reject(new Error(`Webhook failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error(`❌ Webhook error:`, error.message);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook request timeout'));
      });

      req.write(postData);
      req.end();
    });
  } catch (error) {
    console.error('Failed to send webhook:', error);
    throw error;
  }
}

// ==========================================
// EXPRESS МIDDLEWARE
// ==========================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware для логирования запросов
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// ==========================================
// API ENDPOINTS
// ==========================================

// Получение всех диалогов
app.get('/get-dialogs', async (req, res) => {
  try {
    const dialogs = await contentManager.getDialogs();
    res.json(dialogs);
  } catch (error) {
    console.error('Error getting dialogs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Получение сообщений (универсальный endpoint)
app.get('/get-messages', async (req, res) => {
  try {
    const { channel: channelId, limit, offsetId, offsetDate } = req.query;

    if (!channelId) {
      return res.status(400).json({ error: 'channel parameter is required' });
    }

    const options = {
      limit: limit ? parseInt(limit) : 10,
      offsetId: offsetId ? parseInt(offsetId) : 0,
      offsetDate: offsetDate,
    };

    const result = await contentManager.getMessages(channelId, options);
    res.json(result);
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Получение комментариев
app.get('/get-comments', async (req, res) => {
  try {
    const { channel: channelId, message: messageId, limit } = req.query;

    if (!channelId || !messageId) {
      return res.status(400).json({ error: 'channel and message parameters are required' });
    }

    const options = {
      limit: limit ? parseInt(limit) : 50,
    };

    const comments = await contentManager.getComments(channelId, parseInt(messageId), options);
    res.json({ comments });
  } catch (error) {
    console.error('Error getting comments:', error);
    res.status(500).json({ error: error.message });
  }
});

// Регистрация webhook для канала
app.post('/register-webhook', (req, res) => {
  try {
    const { channelId, webhookUrl } = req.body;

    if (!channelId || !webhookUrl) {
      return res.status(400).json({ error: 'channelId and webhookUrl are required' });
    }

    webhookManager.registerWebhook(channelId, webhookUrl);
    res.json({ success: true, message: `Webhook registered for channel ${channelId}` });
  } catch (error) {
    console.error('Error registering webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Удаление webhook
app.post('/unregister-webhook', (req, res) => {
  try {
    const { channelId } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    webhookManager.unregisterWebhook(channelId);
    res.json({ success: true, message: `Webhook unregistered for channel ${channelId}` });
  } catch (error) {
    console.error('Error unregistering webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Статус системы
app.get('/status', (req, res) => {
  const monitoredChannels = channelMonitor.getMonitoredChannels();
  
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    rateLimiter: rateLimiter.getStatus(),
    webhooks: Array.from(webhookManager.webhooks.keys()),
    monitoring: {
      enabled: channelMonitor.eventHandlerInitialized,
      globalWebhookUrl: channelMonitor.getGlobalWebhookUrl() || null,
      totalChannels: monitoredChannels.length,
      channels: monitoredChannels.map(ch => ({
        id: ch.id,
        name: ch.name,
        watchMessages: ch.watchMessages,
        watchComments: ch.watchComments,
        watchReactions: ch.watchReactions
      }))
    },
    config: {
      port: CONFIG.PORT,
      telegramRateLimit: CONFIG.TELEGRAM_RATE_LIMIT,
      queueMaxSize: CONFIG.QUEUE_MAX_SIZE,
    }
  });
});

// Тестовый endpoint
app.post('/webhook-test', (req, res) => {
  console.log('Received webhook test:', req.body);
  res.json({ received: true, timestamp: new Date().toISOString(), data: req.body });
});

// ==========================================
// МОНИТОРИНГ API ENDPOINTS
// ==========================================

// Установка глобального webhook URL
app.post('/monitor/set-webhook', async (req, res) => {
  try {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl is required' });
    }

    await channelMonitor.setGlobalWebhookUrl(webhookUrl);
    res.json({ 
      success: true, 
      message: 'Global webhook URL set successfully',
      webhookUrl 
    });
  } catch (error) {
    console.error('Error setting webhook URL:', error);
    res.status(500).json({ error: error.message });
  }
});

// Добавление канала в мониторинг
app.post('/monitor/add', async (req, res) => {
  try {
    const { channelId, name, watchMessages, watchComments, watchReactions, topicIds, linkedTo } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    const channelConfig = await channelMonitor.addChannel(channelId, {
      name,
      watchMessages: watchMessages !== false, // по умолчанию true
      watchComments: watchComments === true,
      watchReactions: watchReactions === true,
      topicIds: topicIds || [],
      linkedTo: linkedTo || null
    });

    // Инициализировать event handlers если еще не инициализированы
    if (!channelMonitor.eventHandlerInitialized) {
      await initializeEventHandlers();
    }

    res.json({ 
      success: true, 
      message: `Channel ${channelId} added to monitoring`,
      channel: channelConfig
    });
  } catch (error) {
    console.error('Error adding channel to monitoring:', error);
    res.status(500).json({ error: error.message });
  }
});

// Удаление канала из мониторинга
app.post('/monitor/remove', async (req, res) => {
  try {
    const { channelId } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    await channelMonitor.removeChannel(channelId);
    
    res.json({ 
      success: true, 
      message: `Channel ${channelId} removed from monitoring` 
    });
  } catch (error) {
    console.error('Error removing channel from monitoring:', error);
    res.status(500).json({ error: error.message });
  }
});

// Получение списка мониторируемых каналов
app.get('/monitor/list', (req, res) => {
  try {
    const channels = channelMonitor.getMonitoredChannels();
    const webhookUrl = channelMonitor.getGlobalWebhookUrl();
    
    res.json({ 
      success: true,
      globalWebhookUrl: webhookUrl,
      totalChannels: channels.length,
      channels 
    });
  } catch (error) {
    console.error('Error getting monitored channels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Обновление настроек канала
app.post('/monitor/update', async (req, res) => {
  try {
    const { channelId, name, watchMessages, watchComments, watchReactions, topicId, linkedTo } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    // Проверка существования канала
    if (!channelMonitor.isMonitored(channelId)) {
      return res.status(404).json({ error: 'Channel not found in monitoring list' });
    }

    // Обновление через addChannel (он проверяет существование)
    const channelConfig = await channelMonitor.addChannel(channelId, {
      name,
      watchMessages,
      watchComments,
      watchReactions,
      topicId,
      linkedTo
    });

    res.json({ 
      success: true, 
      message: `Channel ${channelId} settings updated`,
      channel: channelConfig
    });
  } catch (error) {
    console.error('Error updating channel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Получение информации о конкретном канале
app.get('/monitor/channel/:channelId', (req, res) => {
  try {
    const { channelId } = req.params;
    
    const channelConfig = channelMonitor.getChannelConfig(channelId);
    
    if (!channelConfig) {
      return res.status(404).json({ error: 'Channel not found in monitoring list' });
    }

    res.json({ 
      success: true,
      channel: channelConfig
    });
  } catch (error) {
    console.error('Error getting channel info:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await telegramManager.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await telegramManager.disconnect();
  process.exit(0);
});

app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Telegram Parser Server запущен на http://localhost:${CONFIG.PORT}`);
  console.log(`📊 Rate limit: ${CONFIG.TELEGRAM_RATE_LIMIT} запросов/сек`);
  console.log(`📋 Максимальный размер очереди: ${CONFIG.QUEUE_MAX_SIZE}`);
  console.log(`🔗 Доступные endpoints:`);
  console.log(`   GET  /get-dialogs           - все диалоги (каналы/группы/пользователи)`);
  console.log(`   GET  /get-messages          - сообщения из канала/группы`);
  console.log(`   GET  /get-comments          - комментарии к сообщению`);
  console.log(`   POST /register-webhook      - регистрация webhook для канала`);
  console.log(`   POST /unregister-webhook    - удаление webhook`);
  console.log(`   GET  /status                - статус сервера`);
  console.log(`   POST /webhook-test          - тест webhook`);
  console.log(``);
  console.log(`📡 Мониторинг endpoints:`);
  console.log(`   POST /monitor/set-webhook   - установка глобального webhook URL`);
  console.log(`   POST /monitor/add           - добавить канал в мониторинг`);
  console.log(`   POST /monitor/remove        - удалить канал из мониторинга`);
  console.log(`   POST /monitor/update        - обновить настройки канала`);
  console.log(`   GET  /monitor/list          - список мониторируемых каналов`);
  console.log(`   GET  /monitor/channel/:id   - информация о канале`);
  console.log(``);
  
  // Загрузка конфигурации мониторинга
  try {
    await channelMonitor.loadConfig();
    const channels = channelMonitor.getMonitoredChannels();
    const webhookUrl = channelMonitor.getGlobalWebhookUrl();
    
    console.log(`📋 Загружено каналов для мониторинга: ${channels.length}`);
    
    if (webhookUrl) {
      console.log(`🔗 Global webhook URL: ${webhookUrl}`);
    } else {
      console.log(`⚠️  Global webhook URL не установлен. Используйте POST /monitor/set-webhook`);
    }
    
    // Инициализация event handlers если есть каналы для мониторинга
    if (channels.length > 0) {
      console.log(`🔄 Инициализация мониторинга каналов...`);
      await initializeEventHandlers();
      console.log(`✅ Мониторинг активен для каналов:`);
      channels.forEach(channel => {
        const features = [];
        if (channel.watchMessages) features.push('сообщения');
        if (channel.watchComments) features.push('комментарии');
        if (channel.watchReactions) features.push('реакции');
        const topicInfo = channel.topicId ? ` [тема: ${channel.topicId}]` : '';
        console.log(`   - ${channel.name} (${channel.id})${topicInfo}: ${features.join(', ')}`);
      });
    } else {
      console.log(`⚠️  Нет каналов для мониторинга. Добавьте через POST /monitor/add`);
    }
  } catch (error) {
    console.error(`❌ Ошибка загрузки конфигурации мониторинга:`, error);
  }
});

module.exports = app;
