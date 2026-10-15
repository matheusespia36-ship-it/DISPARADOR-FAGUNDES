const http = require('http');

const TOKEN = 'minhasenha'; // Altere se tiver mudado o token no config.json
const endpoints = ['/status', '/dispatches', '/history', '/groups'];

console.log('--- TESTANDO ROTAS DO SERVIDOR ---');

endpoints.forEach((path) => {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 3000,
      path: path,
      method: 'GET',
      headers: { 'x-token': TOKEN }
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        console.log(`\n STATUS [${res.statusCode}] - Rota: ${path}`);
        console.log(` RESPOSTA: ${data.substring(0, 150)}...`);
      });
    }
  );

  req.on('error', (err) => {
    console.error(`\n [ERRO CONEXÃO] Rota ${path}: ${err.message}`);
  });

  req.end();
});
