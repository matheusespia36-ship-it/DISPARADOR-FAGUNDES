const { channel } = require('bridge');

console.log("[NodeJS Embedded] Iniciando servidor interno no Android...");

// Redireciona o armazenamento de sessão para a pasta de dados gravável do Android
process.env.AUTH_DIR = process.env.NODEJS_MOBILE_FILES_DIR || __dirname;

// Inicia o servidor backend
require('./server.js');

channel.addListener('ping', () => {
  channel.send('pong');
});
