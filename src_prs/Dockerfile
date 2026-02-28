FROM node:22-alpine

# Установка рабочей директории
WORKDIR /app

# Копирование package.json и package-lock.json
COPY package*.json ./

# Установка зависимостей
RUN npm ci --only=production && npm cache clean --force

# Создание пользователя для безопасности
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Копирование исходного кода
COPY . .

# Изменение владельца файлов
RUN chown -R nodejs:nodejs /app

# Переключение на пользователя nodejs
USER nodejs

# Экспорт порта
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

# Запуск приложения
CMD ["npm", "start"]