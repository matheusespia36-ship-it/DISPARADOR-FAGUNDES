process.on("uncaughtException", err => console.error("[ERRO] Exceção capturada:", err));
process.on("unhandledRejection", reason => console.error("[ERRO] Rejeição capturada:", reason));
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MOCK = process.env.MOCK === '1';
const MAX_BODY = 25 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DISPATCHES_FILE = path.join(DATA_DIR, 'dispatches.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

let config = {};
let dispatches = [];
let history = [];

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
async function addHistory(entry) {
  history.unshift({ id: crypto.randomUUID(), when: new Date().toISOString(), ...entry });
  history = history.slice(0, 200);
  await writeJson(HISTORY_FILE, history);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function authorized(req) {
  const raw = req.headers['x-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(raw));
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
      } else if (!tooBig) {
        chunks.push(c);
      }
    });
    req.on('end', () => (tooBig ? reject(httpError(413, 'Ficheiro grande demais.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw httpError(400, 'JSON inválido.');
  }
}
const pad2 = (n) => String(n).padStart(2, '0');
function fillCaption(text) {
  const d = new Date();
  return String(text)
    .replaceAll('{data}', `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`)
    .replaceAll('{hora}', `${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
}
function pickMime(buf, fileName, given) {
  if (given) return String(given);
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
}

const wa = { status: MOCK ? 'open' : 'starting', qr: null, sock: null };

async function connectWhatsApp() {
  const { default: makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
  const pino = require('pino');
  const authPath = path.join(DATA_DIR, 'auth');
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  
  let version;
  try {
    const vPromise = fetchLatestBaileysVersion();
    const tPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout versão')), 3000));
    const res = await Promise.race([vPromise, tPromise]);
    version = res.version;
  } catch (e) {
    console.log('[WHATSAPP] A utilizar versão padrão interna.');
  }

  console.log('[WHATSAPP] A criar socket de ligação...');
  wa.status = 'connecting';
  wa.qr = null;

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    connectTimeoutMs: 60000,
  });
  wa.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('[WHATSAPP] QR Code atualizado!');
      wa.qr = qr;
      wa.status = 'needsPairing';
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[WHATSAPP] Ligação encerrada (Status: ${statusCode})...`);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        wa.status = 'reconnecting';
        setTimeout(() => connectWhatsApp().catch(console.error), 3000);
      } else {
        wa.status = 'loggedOut';
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {}
        setTimeout(() => connectWhatsApp().catch(console.error), 3000);
      }
    } else if (connection === 'open') {
      wa.status = 'open';
      wa.qr = null;
      console.log('\n========================================');
      console.log(' [SUCESSO] WHATSAPP LIGADO COM SUCESSO!');
      console.log('========================================\n');
    }
  });
}

async function sendToWhatsApp(jid, payload) {
  if (wa.status !== 'open' || !wa.sock) throw httpError(503, 'WhatsApp desligado.');
  await wa.sock.sendMessage(jid, payload);
}

async function listGroups() {
  if (wa.status !== 'open' || !wa.sock) throw httpError(503, 'WhatsApp desligado.');
  const all = await wa.sock.groupFetchAllParticipating();
  return Object.values(all).map((g) => ({ id: g.id, name: g.subject, participants: g.participants?.length ?? 0 })).sort((a, b) => a.name.localeCompare(b.name, 'pt-PT'));
}

// MOTOR DO AGENDADOR (Inspeciona horários a cada 60s)
function startScheduler() {
  setInterval(async () => {
    if (wa.status !== 'open') return;
    
    const now = new Date();
    const currentHM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const timestamp = now.getTime();

    for (const d of dispatches) {
      if (!d.active) continue;

      let shouldRun = false;

      if (d.schedType === 'fixed' && d.schedValue) {
        const times = d.schedValue.split(',').map(t => t.trim());
        if (times.includes(currentHM) && d.lastRunHM !== currentHM) {
          shouldRun = true;
          d.lastRunHM = currentHM;
        }
      } else if (d.schedType === 'interval' && d.schedValue) {
        const intervalMs = Number(d.schedValue) * 60 * 1000;
        if (intervalMs > 0 && (!d.lastRunTs || (timestamp - d.lastRunTs) >= intervalMs)) {
          shouldRun = true;
          d.lastRunTs = timestamp;
        }
      }

      if (shouldRun && d.lastMessage) {
        console.log(`[AGENDADOR] Executando disparo automático: ${d.name}`);
        try {
          const captionText = fillCaption(d.caption || '');
          const buf = Buffer.from(d.lastMessage.fileBase64, 'base64');
          const payload = d.lastMessage.mimetype.startsWith('image/')
            ? { image: buf, mimetype: d.lastMessage.mimetype, caption: captionText }
            : { document: buf, mimetype: d.lastMessage.mimetype, fileName: d.lastMessage.fileName || 'arquivo', caption: captionText };

          await sendToWhatsApp(d.groupJid, payload);
          await addHistory({ slug: d.slug, name: d.name, group: d.groupName, ok: true, auto: true });
          await writeJson(DISPATCHES_FILE, dispatches);
        } catch (err) {
          console.error(`[ERRO AGENDADOR] ${d.name}:`, err.message);
          await addHistory({ slug: d.slug, name: d.name, group: d.groupName, ok: false, error: err.message, auto: true });
        }
      }
    }
  }, 60000);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      return json(res, 404, { ok: false, error: 'index.html não encontrado.' });
    }
  }

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Chave inválida ou ausente.' });

  if (method === 'GET' && p === '/status') return json(res, 200, { ok: true, whatsapp: wa.status, mock: MOCK, dispatches: dispatches.length });
  if (method === 'GET' && p === '/groups') return json(res, 200, { ok: true, groups: await listGroups() });
  if (method === 'GET' && p === '/dispatches') return json(res, 200, { ok: true, dispatches });
  if (method === 'GET' && p === '/history') return json(res, 200, { ok: true, history });

  if (method === 'GET' && p === '/qr') {
    if (wa.status === 'open') return json(res, 200, { ok: false, message: 'Já ligado' });
    if (!wa.qr) return json(res, 200, { ok: false, message: 'A aguardar QR Code...' });
    try {
      const qrImage = await QRCode.toDataURL(wa.qr);
      return json(res, 200, { ok: true, qr: qrImage });
    } catch (e) {
      return json(res, 500, { ok: false, error: 'Erro ao gerar QR' });
    }
  }

  if (method === 'POST' && p === '/pair-code') {
    if (wa.status === 'open') return json(res, 400, { ok: false, error: 'Já ligado.' });
    if (!wa.sock) return json(res, 500, { ok: false, error: 'Socket não pronto.' });
    
    const body = parseJson(await readBody(req));
    let phone = String(body.phone || '').replace(/\D/g, '');
    
    if (phone.length === 13 && phone.startsWith('55')) {
      const ddd = phone.substring(2, 4);
      const rest = phone.substring(4);
      if (rest.length === 9 && rest.startsWith('9')) {
        phone = '55' + ddd + rest.substring(1);
      }
    }

    if (phone.length < 10) return json(res, 400, { ok: false, error: 'Número inválido.' });

    try {
      const codePromise = wa.sock.requestPairingCode(phone);
      const timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error('Timeout ao obter código')), 12000));
      const code = await Promise.race([codePromise, timeoutPromise]);
      return json(res, 200, { ok: true, code });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || 'Falha ao obter código.' });
    }
  }

  if (method === 'POST' && p === '/reset-session') {
    try {
      fs.rmSync(path.join(DATA_DIR, 'auth'), { recursive: true, force: true });
      if (wa.sock) { wa.sock.end(undefined); wa.sock = null; }
      wa.status = 'needsPairing';
      wa.qr = null;
      setTimeout(() => connectWhatsApp().catch(console.error), 2000);
      return json(res, 200, { ok: true, message: 'Sessão reiniciada.' });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  let m = p.match(/^\/dispatches\/([^/]+)$/);
  if (m) {
    const slug = m[1];
    if (method === 'PUT') {
      const b = parseJson(await readBody(req));
      const old = dispatches.find(x => x.slug === slug) || {};
      const rec = {
        slug,
        name: String(b.name || slug),
        groupJid: b.groupJid,
        groupName: b.groupName,
        caption: String(b.caption || ''),
        schedType: b.schedType || 'none',
        schedValue: String(b.schedValue || ''),
        active: b.active !== false,
        lastMessage: old.lastMessage || null,
        lastRunTs: old.lastRunTs || 0,
        lastRunHM: old.lastRunHM || ''
      };
      dispatches = [...dispatches.filter((x) => x.slug !== slug), rec];
      await writeJson(DISPATCHES_FILE, dispatches);
      return json(res, 200, { ok: true, dispatch: rec });
    }
    if (method === 'DELETE') {
      dispatches = dispatches.filter((x) => x.slug !== slug);
      await writeJson(DISPATCHES_FILE, dispatches);
      return json(res, 200, { ok: true });
    }
  }

  m = p.match(/^\/send\/([^/]+)$/);
  if (m && method === 'POST') {
    const slug = m[1];
    const body = parseJson(await readBody(req));
    const b64 = body.fileBase64 ?? body.imageBase64;
    if (!b64) throw httpError(400, 'Falta o ficheiro.');
    const buf = Buffer.from(b64, 'base64');
    const mimetype = pickMime(buf, body.fileName, body.mimetype);
    const captionText = fillCaption(body.caption || '');
    const payload = mimetype.startsWith('image/') ? { image: buf, mimetype, caption: captionText } : { document: buf, mimetype, fileName: body.fileName || 'ficheiro', caption: captionText };
    
    // Guardar última imagem/mensagem no disparo para permitir reenvio automático pelo agendador
    const targetDisp = dispatches.find(x => x.slug === slug);
    if (targetDisp) {
      targetDisp.lastMessage = { fileBase64: b64, mimetype, fileName: body.fileName || 'ficheiro' };
      await writeJson(DISPATCHES_FILE, dispatches);
    }

    await sendToWhatsApp(body.groupJid || (targetDisp ? targetDisp.groupJid : body.target), payload);
    await addHistory({ slug, name: targetDisp ? targetDisp.name : slug, group: targetDisp ? targetDisp.groupName : 'Direto', ok: true });
    return json(res, 200, { ok: true, message: 'Enviado com sucesso' });
  }

  return json(res, 404, { ok: false, error: 'Rota não encontrada.' });
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  config = await readJson(CONFIG_FILE, {});
  if (process.env.TOKEN) config.token = process.env.TOKEN;
  if (!config.token) config.token = 'minhasenha';
  await writeJson(CONFIG_FILE, config);
  dispatches = await readJson(DISPATCHES_FILE, []);
  history = await readJson(HISTORY_FILE, []);

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) json(res, err.status || 500, { ok: false, error: err.message });
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('\n========================================');
    console.log(' DISPARADOR WHATSAPP NO AR');
    console.log(` Senha de envio: ${config.token}`);
    ips.forEach(ip => console.log(`   http://${ip}:${PORT}`));
    console.log('========================================\n');
    connectWhatsApp().catch(console.error);
    startScheduler();
  });
}
main();
