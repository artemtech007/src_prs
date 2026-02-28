
const { StringSession } = require('telegram/sessions');
const { TelegramClient } = require('telegram');
const input = require('input'); // npm install input

const apiId = 29144298; // Замени на свой
const apiHash = 'c7de9e995af38c92eaa5ab91bea1f48f'; // Замени на свой
const stringSession = new StringSession(''); 

(async () => {
  console.log('Loading interactive session...');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text('Введите номер: '),
    password: async () => await input.text('Введите 2FA пароль: '),
    phoneCode: async () => await input.text('Введите код из Telegram: '),
    onError: (err) => console.log(err),
  });
  console.log('Авторизация прошла успешно!');
  console.log('SESSION STRING:', client.session.save());
})();
