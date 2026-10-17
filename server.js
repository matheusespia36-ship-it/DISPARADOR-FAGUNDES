
process.on("uncaughtException", err => console.error("[ERRO] Exceção capturada:", err));
process.on("unhandledRejection", reason => console.error("[ERRO] Rejeição capturada:", reason));
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');

const PORT = 3000;
const DATA_DIR = fs.existsSync(path.join(__dirname, 'data'))
  ? path.join(__dirname, 'data')
  : path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

function getIndexHtmlPath() {
  const candidates = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'www', 'index.html'),
    process.env.PUBLIC_DIR && fs.existsSync(process.env.PUBLIC_DIR) && fs.statSync(process.env.PUBLIC_DIR).isFile() ? process.env.PUBLIC_DIR : null,
    process.env.PUBLIC_DIR ? path.join(process.env.PUBLIC_DIR, 'index.html') : null,
    path.join(__dirname, 'index.html')
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return path.join(__dirname, 'public', 'index.html');
}
const PUBLIC_DIR = path.dirname(getIndexHtmlPath());

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-token'
  });
  res.end(JSON.stringify(body));
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function authorized(req) {
  let queryToken = '';
  try { queryToken = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch(e) {}
  const raw = req.headers['x-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || queryToken;
  if (!config.token) return true;
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
function getHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
const pad2 = (n) => String(n).padStart(2, '0');
function fillCaption(text) {
  const d = new Date();
  return String(text)
    .replaceAll('{data}', `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`)
    .replaceAll('{hora}', `${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
}
function pickMime(buf, fileName, given) {
  if (given && given !== 'application/octet-stream') return String(given);
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const extMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip'
  };
  return extMap[ext] || given || 'application/octet-stream';
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
  if (wa.status !== 'open' || !wa.sock) return [];
  try {
    const all = await wa.sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({ id: g.id, name: g.subject, participants: g.participants?.length ?? 0 })).sort((a, b) => a.name.localeCompare(b.name, 'pt-PT'));
  } catch (err) {
    console.warn('[WHATSAPP] Erro ao listar grupos:', err.message);
    return [];
  }
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
        const dayHMKey = `${now.getDate()}-${currentHM}`;
        if (times.includes(currentHM) && d.lastRunHM !== dayHMKey) {
          shouldRun = true;
          d.lastRunHM = dayHMKey;
        }
      } else if (d.schedType === 'interval' && d.schedValue) {
        const intervalMs = Number(d.schedValue) * 60 * 1000;
        if (intervalMs > 0 && (!d.lastRunTs || (timestamp - d.lastRunTs) >= intervalMs)) {
          shouldRun = true;
          d.lastRunTs = timestamp;
        }
      }

      if (shouldRun && d.lastMessage) {
        const buf = Buffer.from(d.lastMessage.fileBase64, 'base64');
        const fileHash = d.lastMessage.fileHash || getHash(buf);
        const fileName = d.lastMessage.fileName || 'arquivo';

        // Evitar duplicados se preventDuplicates estiver ativo e o arquivo for idêntico ao já enviado
        const windowMin = Number(d.duplicateWindowMinutes || 0);
        const windowMs = windowMin * 60 * 1000;
        const withinWindow = !windowMs || (d.lastSentAt && (timestamp - new Date(d.lastSentAt).getTime()) < windowMs);

        if (d.preventDuplicates !== false && d.lastSentHash === fileHash && withinWindow) {
          console.log(`[AGENDADOR] Arquivo idêntico (${fileName}) já enviado anteriormente para "${d.name}". Envio duplicado evitado.`);
          await addHistory({
            slug: d.slug,
            name: d.name,
            group: d.groupName,
            ok: true,
            auto: true,
            fileName,
            note: 'Duplicidade evitada: arquivo com mesmo conteúdo já despachado anteriormente'
          });
          continue;
        }

        console.log(`[AGENDADOR] Executando disparo automático: ${d.name} (${fileName})`);
        try {
          const captionText = fillCaption(d.caption || '');
          const payload = d.lastMessage.mimetype.startsWith('image/')
            ? { image: buf, mimetype: d.lastMessage.mimetype, caption: captionText }
            : { document: buf, mimetype: d.lastMessage.mimetype, fileName, caption: captionText };

          await sendToWhatsApp(d.groupJid, payload);
          d.lastSentHash = fileHash;
          d.lastSentName = fileName;
          d.lastSentAt = new Date().toISOString();
          await addHistory({ slug: d.slug, name: d.name, group: d.groupName, ok: true, auto: true, fileName });
          await writeJson(DISPATCHES_FILE, dispatches);
        } catch (err) {
          console.error(`[ERRO AGENDADOR] ${d.name}:`, err.message);
          await addHistory({ slug: d.slug, name: d.name, group: d.groupName, ok: false, error: err.message, auto: true, fileName });
        }
      }
    }
  }, 60000);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-token'
    });
    return res.end();
  }

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const indexPath = getIndexHtmlPath();
      let html = await fsp.readFile(indexPath, 'utf8');
      const injectedScript = `<script>window.SERVER_TOKEN = ${JSON.stringify(config.token || 'minhasenha')}; window.BACKEND_URL = '';</script>`;
      if (html.includes('</head>')) {
        html = html.replace('</head>', `${injectedScript}</head>`);
      } else {
        html = injectedScript + html;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(html);
    } catch (e) {
      return json(res, 404, { ok: false, error: 'index.html não encontrado: ' + e.message });
    }
  }

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Chave inválida ou ausente.' });

  if (method === 'GET' && p === '/status') {
    let qrData = null;
    if (wa.qr && wa.status !== 'open') {
      try { qrData = await QRCode.toDataURL(wa.qr); } catch (e) {}
    }
    return json(res, 200, {
      ok: true,
      whatsapp: wa.status,
      mock: MOCK,
      dispatches: dispatches.length,
      qr: qrData
    });
  }
  if (method === 'GET' && p === '/groups') return json(res, 200, { ok: true, groups: await listGroups() });
  if (method === 'GET' && p === '/dispatches') return json(res, 200, { ok: true, dispatches });
  if (method === 'GET' && p === '/history') return json(res, 200, { ok: true, history });
  if (method === 'DELETE' && p === '/history') {
    history = [];
    await writeJson(HISTORY_FILE, history);
    return json(res, 200, { ok: true, message: 'Histórico limpo' });
  }

  if (method === 'POST' && p === '/test') {
    return json(res, 200, {
      ok: true,
      message: wa.status === 'open' ? 'WhatsApp ligado e operacional!' : 'Servidor online. Status: ' + wa.status,
      whatsapp: wa.status
    });
  }

  if (method === 'POST' && p === '/config') {
    const body = parseJson(await readBody(req));
    if (body.token) config.token = String(body.token).trim();
    await writeJson(CONFIG_FILE, config);
    return json(res, 200, { ok: true, config });
  }

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

  if (method === 'POST' && p === '/dispatches') {
    const b = parseJson(await readBody(req));
    const rawSlug = String(b.slug || b.name || 'disparo');
    const slug = rawSlug.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'disparo';
    const old = dispatches.find(x => x.slug === slug) || {};

    let lastMsg = b.lastMessage !== undefined ? b.lastMessage : (old.lastMessage || null);
    if (b.fileBase64) {
      const fileBuf = Buffer.from(b.fileBase64, 'base64');
      const fName = b.fileName || 'arquivo';
      const fMime = pickMime(fileBuf, fName, b.mimetype);
      const fHash = getHash(fileBuf);
      lastMsg = {
        fileBase64: b.fileBase64,
        fileName: fName,
        mimetype: fMime,
        fileHash: fHash,
        fileSize: fileBuf.length,
        updatedAt: new Date().toISOString()
      };
    } else if (b.removeFile === true) {
      lastMsg = null;
    }

    const rec = {
      slug,
      name: String(b.name || slug),
      groupJid: b.groupJid,
      groupName: b.groupName,
      caption: String(b.caption || ''),
      schedType: b.schedType || 'none',
      schedValue: String(b.schedValue || ''),
      active: b.active !== false,
      preventDuplicates: b.preventDuplicates !== false,
      autoReplaceSameName: b.autoReplaceSameName !== false,
      duplicateWindowMinutes: b.duplicateWindowMinutes !== undefined ? Number(b.duplicateWindowMinutes) : 0,
      lastMessage: lastMsg,
      lastSentHash: old.lastSentHash || null,
      lastSentName: old.lastSentName || null,
      lastSentAt: old.lastSentAt || null,
      lastRunTs: old.lastRunTs || 0,
      lastRunHM: old.lastRunHM || ''
    };
    dispatches = [...dispatches.filter((x) => x.slug !== slug), rec];
    await writeJson(DISPATCHES_FILE, dispatches);
    return json(res, 200, { ok: true, dispatch: rec });
  }

  let m = p.match(/^\/dispatches\/([^/]+)\/file$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const targetDisp = dispatches.find(x => x.slug === slug);
    if (!targetDisp) return json(res, 404, { ok: false, error: 'Disparo não encontrado' });

    if (method === 'GET' || method === 'HEAD') {
      if (!targetDisp.lastMessage || !targetDisp.lastMessage.fileBase64) {
        return json(res, 404, { ok: false, error: 'Nenhum arquivo anexado a este disparo.' });
      }
      const buf = Buffer.from(targetDisp.lastMessage.fileBase64, 'base64');
      const safeName = (targetDisp.lastMessage.fileName || 'arquivo').replace(/[^\w\.\-\s]/gi, '_');
      res.writeHead(200, {
        'Content-Type': targetDisp.lastMessage.mimetype || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*'
      });
      if (method === 'HEAD') return res.end();
      return res.end(buf);
    }

    if (method === 'DELETE') {
      targetDisp.lastMessage = null;
      await writeJson(DISPATCHES_FILE, dispatches);
      return json(res, 200, { ok: true, message: 'Arquivo removido do disparo' });
    }

    if (method === 'POST') {
      const body = parseJson(await readBody(req));
      const b64 = body.fileBase64 ?? body.imageBase64;
      if (!b64) throw httpError(400, 'Falta o ficheiro base64.');
      const buf = Buffer.from(b64, 'base64');
      const fileName = body.fileName || 'arquivo';
      const fileHash = getHash(buf);
      const mimetype = pickMime(buf, fileName, body.mimetype);

      const hadPrevious = Boolean(targetDisp.lastMessage);
      const prevName = targetDisp.lastMessage ? targetDisp.lastMessage.fileName : '';

      targetDisp.lastMessage = {
        fileBase64: b64,
        mimetype,
        fileName,
        fileHash,
        fileSize: buf.length,
        updatedAt: new Date().toISOString()
      };
      await writeJson(DISPATCHES_FILE, dispatches);
      
      const replaceMsg = hadPrevious 
        ? `Novo arquivo "${fileName}" recebido com sucesso. Versão anterior${prevName === fileName ? ' de mesmo nome' : ''} foi substituída para não gerar duplicados.`
        : `Arquivo "${fileName}" anexado com sucesso ao disparo.`;

      return json(res, 200, {
        ok: true,
        message: replaceMsg,
        file: {
          fileName,
          fileSize: buf.length,
          mimetype,
          fileHash,
          updatedAt: targetDisp.lastMessage.updatedAt
        }
      });
    }
  }

  m = p.match(/^\/dispatches\/([^/]+)$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    if (method === 'PUT') {
      const b = parseJson(await readBody(req));
      const old = dispatches.find(x => x.slug === slug) || {};
      const targetSlug = b.newSlug ? String(b.newSlug) : (b.slug ? String(b.slug) : slug);

      let lastMsg = b.lastMessage !== undefined ? b.lastMessage : (old.lastMessage || null);
      if (b.fileBase64) {
        const fileBuf = Buffer.from(b.fileBase64, 'base64');
        const fName = b.fileName || 'arquivo';
        const fMime = pickMime(fileBuf, fName, b.mimetype);
        const fHash = getHash(fileBuf);
        lastMsg = {
          fileBase64: b.fileBase64,
          fileName: fName,
          mimetype: fMime,
          fileHash: fHash,
          fileSize: fileBuf.length,
          updatedAt: new Date().toISOString()
        };
      } else if (b.removeFile === true) {
        lastMsg = null;
      }

      const rec = {
        slug: targetSlug,
        name: String(b.name || targetSlug),
        groupJid: b.groupJid !== undefined ? b.groupJid : old.groupJid,
        groupName: b.groupName !== undefined ? b.groupName : old.groupName,
        caption: b.caption !== undefined ? String(b.caption) : (old.caption || ''),
        schedType: b.schedType !== undefined ? b.schedType : (old.schedType || 'none'),
        schedValue: b.schedValue !== undefined ? String(b.schedValue) : (old.schedValue || ''),
        active: b.active !== undefined ? b.active : (old.active !== false),
        preventDuplicates: b.preventDuplicates !== undefined ? b.preventDuplicates !== false : (old.preventDuplicates !== false),
        autoReplaceSameName: b.autoReplaceSameName !== undefined ? b.autoReplaceSameName !== false : (old.autoReplaceSameName !== false),
        duplicateWindowMinutes: b.duplicateWindowMinutes !== undefined ? Number(b.duplicateWindowMinutes) : (old.duplicateWindowMinutes !== undefined ? Number(old.duplicateWindowMinutes) : 0),
        lastMessage: lastMsg,
        lastSentHash: old.lastSentHash || null,
        lastSentName: old.lastSentName || null,
        lastSentAt: old.lastSentAt || null,
        lastRunTs: old.lastRunTs || 0,
        lastRunHM: old.lastRunHM || ''
      };
      dispatches = [...dispatches.filter((x) => x.slug !== slug && x.slug !== targetSlug), rec];
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
    const slug = decodeURIComponent(m[1]);
    const body = parseJson(await readBody(req));
    const targetDisp = dispatches.find(x => x.slug === slug);
    
    // Suporte para usar arquivo já anexado ao disparo se o body não enviar outro
    let b64 = body.fileBase64 ?? body.imageBase64;
    let fileName = body.fileName;
    let mimetype = body.mimetype;

    if (!b64 && targetDisp && targetDisp.lastMessage) {
      b64 = targetDisp.lastMessage.fileBase64;
      fileName = fileName || targetDisp.lastMessage.fileName;
      mimetype = mimetype || targetDisp.lastMessage.mimetype;
    }

    if (!b64) throw httpError(400, 'Nenhum ficheiro fornecido ou anexado a este disparo.');

    const buf = Buffer.from(b64, 'base64');
    fileName = fileName || 'arquivo';
    mimetype = pickMime(buf, fileName, mimetype);
    const fileHash = getHash(buf);
    const captionText = fillCaption(body.caption || (targetDisp ? targetDisp.caption : ''));
    const payload = mimetype.startsWith('image/')
      ? { image: buf, mimetype, caption: captionText }
      : { document: buf, mimetype, fileName, caption: captionText };

    const isStageOnly = body.stageOnly === true || url.searchParams.get('stage') === '1';

    // Anti-duplicação: Se preventDuplicates estiver ativo e o arquivo recebido for idêntico ao já enviado anteriormente
    const windowMinutes = Number(targetDisp ? (targetDisp.duplicateWindowMinutes || 0) : 0);
    const windowMs = windowMinutes * 60 * 1000;
    const isWithinWindow = !windowMs || (targetDisp && targetDisp.lastSentAt && (Date.now() - new Date(targetDisp.lastSentAt).getTime()) < windowMs);

    if (targetDisp && targetDisp.preventDuplicates !== false && targetDisp.lastSentHash === fileHash && isWithinWindow && !body.force) {
      console.log(`[DEDUPLICAÇÃO] Arquivo idêntico (${fileName}) recebido para "${targetDisp.name}", já enviado anteriormente. Duplicidade evitada.`);
      await addHistory({
        slug,
        name: targetDisp.name,
        group: targetDisp.groupName || 'Direto',
        ok: true,
        fileName,
        note: `Duplicidade evitada: "${fileName}" possui conteúdo idêntico ao já despachado anteriormente.`
      });
      return json(res, 200, {
        ok: true,
        skipped: true,
        deduplicated: true,
        message: `Arquivo "${fileName}" recebido com sucesso. Como seu conteúdo é idêntico ao já disparado, o envio duplicado foi evitado para não repetir no grupo.`,
        fileName,
        fileHash
      });
    }

    // Se o arquivo for novo ou atualizado, substitui no disparo para não haver cópias antigas duplicadas
    if (targetDisp) {
      targetDisp.lastMessage = {
        fileBase64: b64,
        mimetype,
        fileName,
        fileHash,
        fileSize: buf.length,
        updatedAt: new Date().toISOString()
      };
      await writeJson(DISPATCHES_FILE, dispatches);
    }

    if (isStageOnly) {
      return json(res, 200, {
        ok: true,
        staged: true,
        message: `Novo arquivo "${fileName}" recebido e armazenado. A versão anterior foi substituída e será despachada no próximo horário agendado sem duplicados.`,
        fileName,
        fileHash
      });
    }

    await sendToWhatsApp(body.groupJid || (targetDisp ? targetDisp.groupJid : body.target), payload);
    if (targetDisp) {
      targetDisp.lastSentHash = fileHash;
      targetDisp.lastSentName = fileName;
      targetDisp.lastSentAt = new Date().toISOString();
      await writeJson(DISPATCHES_FILE, dispatches);
    }
    await addHistory({ slug, name: targetDisp ? targetDisp.name : slug, group: targetDisp ? targetDisp.groupName : 'Direto', ok: true, fileName });
    return json(res, 200, { ok: true, message: `Disparado com sucesso: ${fileName}`, fileHash });
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

