/**
 * Spiaggia Blu – Backend pure Node.js
 * Auth JWT · Multi-stagione · Stripe + Satispay + Contanti · JSON DB
 * File dinamiche · Banner · Penale cancellazione
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const querystring = require('querystring');

// ---- .env ----
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const { sendBookingConfirmation, sendAdminNotification, smtpConfigured } = require('./mail');

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'spiaggia_blu_secret_2026';
// Su Render: RENDER_EXTERNAL_URL è impostato automaticamente
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const FRONTEND = process.env.SPIAGGIA_FRONTEND || path.join(__dirname, '..', 'frontend');
const DB_FILE = process.env.SPIAGGIA_DB ? path.join(process.env.SPIAGGIA_DB, 'data.json') : path.join(__dirname, 'db', 'data.json');
const UPLOADS = path.join(FRONTEND, 'uploads');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PK = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_LIVE = STRIPE_KEY.startsWith('sk_live_');
const STRIPE_OK = STRIPE_KEY && !STRIPE_KEY.includes('PLACEHOLDER');

function defaultSeasons() {
  const y = new Date().getFullYear();
  return [
    { id: 'S' + y, name: `Estate ${y}`, start: `${y}-05-15`, end: `${y}-09-30`, active: true },
    { id: 'S' + (y + 1), name: `Estate ${y + 1}`, start: `${y + 1}-05-15`, end: `${y + 1}-09-30`, active: true },
    { id: 'S' + (y + 2), name: `Estate ${y + 2}`, start: `${y + 2}-05-15`, end: `${y + 2}-09-30`, active: false }
  ];
}

function defaultSettings() {
  return {
    beachName: 'Spiaggia Blu',
    bannerEnabled: true,
    bannerText: '🏖️ Benvenuti! Prenota online e risparmia con i pacchetti settimanali e mensili.',
    bannerBg: '#0a7ea4',
    bannerColor: '#ffffff',
    cancellationPenalty: 15,
    paymentCash: true,
    paymentSatispay: true,
    paymentStripe: true,
    satispayQrUrl: null,
    satispayNote: 'Scansiona il QR Satispay e indica l\'ID prenotazione nel messaggio.',
    beachMapUrl: null,
    refundNoticeEnabled: true,
    refundNoticeText: 'Per cancellazioni prenotazioni con pagamento Carta di credito e Satispay il rimborso sarà riaccreditato con una penale di € {penale}.'
  };
}

function defaultRows() {
  const rows = [];
  for (let f = 1; f <= 8; f++) {
    rows.push({ id: f, name: `File ${f}`, seats: 12, order: f, startNumber: 1 });
  }
  return rows;
}

function defaultData() {
  const prices = {}, seats = {};
  const rows = defaultRows();
  for (const r of rows) {
    prices[r.id] = { giornaliera: 25 + (8 - r.id) * 5, scontoSettimanale: 10, scontoQuindicinale: 15, scontoMensile: 20 };
    for (let p = 1; p <= r.seats; p++) {
      seats[`F${r.id}-P${p}`] = { id: `F${r.id}-P${p}`, fila: r.id, posto: p, status: 'available' };
    }
  }
  return {
    users: [],
    prices,
    seats,
    rows,
    bookings: [],
    seasons: defaultSeasons(),
    settings: defaultSettings(),
    _seq: 1
  };
}

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!d.seasons) d.seasons = defaultSeasons();
      if (!d.settings) d.settings = defaultSettings();
      if (d.settings && d.settings.beachMapUrl === undefined) d.settings.beachMapUrl = null;
      if (d.settings && d.settings.refundNoticeEnabled === undefined) d.settings.refundNoticeEnabled = true;
      if (d.settings && !d.settings.refundNoticeText) {
        d.settings.refundNoticeText = 'Per cancellazioni prenotazioni con pagamento Carta di credito e Satispay il rimborso sarà riaccreditato con una penale di € {penale}.';
      }
      if (!d.rows) {
        d.rows = defaultRows();
      } else {
        // Migrazione: startNumber per numerazione ombrelloni
        for (const r of d.rows) {
          if (r.startNumber === undefined || r.startNumber === null) r.startNumber = 1;
        }
      }
      // Ensure seats match rows
      if (!d.seats) d.seats = {};
      if (!d.prices) d.prices = {};
      return d;
    }
  } catch (e) {
    console.error('loadDB error:', e.message);
  }
  return defaultData();
}

function saveDB() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.scryptSync(pw, salt, 64).toString('hex') === hash;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signJWT(payload, expSec = 7 * 86400) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expSec }));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
function verifyJWT(token) {
  try {
    const [h, p, s] = token.split('.');
    if (crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function seed() {
  if (db.users.length) return;
  db.users.push({
    id: db._seq++, email: (process.env.ADMIN_EMAIL || 'admin@spiaggiablu.it').toLowerCase(),
    password_hash: hashPassword(process.env.ADMIN_PASSWORD || 'Admin123!'),
    nome: 'Amministratore', telefono: '', role: 'admin', created_at: new Date().toISOString()
  });
  db.users.push({
    id: db._seq++, email: 'mario@email.com', password_hash: hashPassword('User123!'),
    nome: 'Mario Rossi', telefono: '+39 333 1234567', role: 'user', created_at: new Date().toISOString()
  });
  if (!db.seasons) db.seasons = defaultSeasons();
  if (!db.settings) db.settings = defaultSettings();
  if (!db.rows) db.rows = defaultRows();
  saveDB();
  console.log('✓ DB inizializzato');
}

function uid() {
  return 'PR' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Sconti progressivi per pacchetto giornaliera:
 * - >= 7 giorni → sconto settimanale
 * - >= 15 giorni → sconto quindicinale
 * - >= 30 giorni → sconto mensile
 * Per i pacchetti fissi si applica lo sconto del pacchetto scelto.
 */
function calcPrice(fila, pkg, numDays) {
  const p = db.prices[fila];
  if (!p) return 0;
  let total = p.giornaliera * numDays;
  let sconto = 0;

  if (pkg === 'settimanale') {
    sconto = p.scontoSettimanale;
  } else if (pkg === 'quindicinale') {
    sconto = p.scontoQuindicinale;
  } else if (pkg === 'mensile') {
    sconto = p.scontoMensile;
  } else if (pkg === 'giornaliera') {
    // Progressivo: mantiene lo sconto fino alla soglia successiva
    if (numDays >= 30) sconto = p.scontoMensile;
    else if (numDays >= 15) sconto = p.scontoQuindicinale;
    else if (numDays >= 7) sconto = p.scontoSettimanale;
    else if (numDays >= 4) sconto = Math.min(5 + (numDays - 4) * 1.5, p.scontoSettimanale || 10);
  }
  return Math.round(total * (1 - sconto / 100) * 100) / 100;
}

function isSeatFree(seatId, start, end, excludeId = null) {
  const seat = db.seats[seatId];
  if (!seat || seat.status === 'blocked') return false;
  return !db.bookings.some(b =>
    b.seat_id === seatId && b.status !== 'cancelled' && b.id !== excludeId &&
    b.data_inizio <= end && b.data_fine >= start
  );
}

/** Occupazioni di un posto (per tooltip hover) */
function getSeatOccupancies(seatId) {
  return db.bookings
    .filter(b => b.seat_id === seatId && b.status !== 'cancelled')
    .map(b => ({
      id: b.id,
      start: b.data_inizio,
      end: b.data_fine,
      status: b.status,
      package: b.package
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function getSeason(id) { return (db.seasons || []).find(s => s.id === id); }
function isDateInSeason(dateStr, season) {
  return season && dateStr >= season.start && dateStr <= season.end;
}

function getSettings() {
  if (!db.settings) db.settings = defaultSettings();
  return db.settings;
}

async function notifyBookingConfirmed(booking) {
  try {
    const user = db.users.find(u => u.id === booking.user_id);
    const season = getSeason(booking.season_id);
    const seasonName = season ? season.name : null;
    if (user && user.email) {
      await sendBookingConfirmation({ to: user.email, nome: user.nome, booking, seasonName });
    }
    await sendAdminNotification({
      booking,
      customer: user ? { nome: user.nome, email: user.email, telefono: user.telefono } : null,
      seasonName
    });
  } catch (err) {
    console.error('notifyBookingConfirmed:', err.message);
  }
}

function bookingsToCsv(bookings) {
  const header = ['id','user_id','user_nome','user_email','user_telefono','seat_id','fila','package','season_id','season_name','data_inizio','data_fine','giorni','prezzo','status','payment_method','created_at'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const rows = bookings.map(b => {
    const u = db.users.find(x => x.id === b.user_id);
    const s = getSeason(b.season_id);
    return [
      b.id, b.user_id, u?.nome || '', u?.email || '', u?.telefono || '', b.seat_id, b.fila, b.package,
      b.season_id || '', s?.name || '', b.data_inizio, b.data_fine, b.giorni,
      b.prezzo, b.status, b.payment_method || '', b.created_at
    ].map(esc).join(',');
  });
  return header.join(',') + '\n' + rows.join('\n') + '\n';
}

const PACKAGE_DAYS = { giornaliera: null, settimanale: 7, quindicinale: 15, mensile: 30 };
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function stripeRequest(method, apiPath, params = null) {
  return new Promise((resolve, reject) => {
    const body = params ? querystring.stringify(params) : null;
    const opts = {
      hostname: 'api.stripe.com',
      path: apiPath,
      method,
      headers: {
        Authorization: 'Bearer ' + STRIPE_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || 'Stripe error'));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function verifyStripeSignature(rawBody, sigHeader) {
  if (!STRIPE_WHSEC || STRIPE_WHSEC.includes('PLACEHOLDER')) return null;
  try {
    const parts = {};
    sigHeader.split(',').forEach(p => {
      const [k, v] = p.split('=');
      parts[k] = v;
    });
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return null;
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return null;
    const signed = crypto.createHmac('sha256', STRIPE_WHSEC)
      .update(timestamp + '.' + rawBody).digest('hex');
    if (signed !== signature) return null;
    return JSON.parse(rawBody);
  } catch { return null; }
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    ...headers
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('multipart/form-data')) {
        resolve({ raw, json: {}, multipart: true, contentType });
      } else {
        const str = raw.toString();
        try { resolve({ raw: str, json: str ? JSON.parse(str) : {}, multipart: false }); }
        catch { resolve({ raw: str, json: {}, multipart: false }); }
      }
    });
    req.on('error', reject);
  });
}

function parseMultipart(raw, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  const boundary = m[1] || m[2];
  const parts = raw.toString('binary').split('--' + boundary);
  const result = { fields: {}, files: {} };
  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || !part.trim()) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const nameMatch = headers.match(/name="([^"]+)"/i);
    const filenameMatch = headers.match(/filename="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (filenameMatch) {
      const filename = filenameMatch[1];
      const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      result.files[name] = {
        filename,
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: Buffer.from(body, 'binary')
      };
    } else {
      result.fields[name] = body;
    }
  }
  return result;
}

function getAuth(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return verifyJWT(h.slice(7));
}

function rebuildSeatsFromRows() {
  const newSeats = {};
  for (const r of (db.rows || [])) {
    const startNum = Math.max(1, parseInt(r.startNumber, 10) || 1);
    if (r.startNumber === undefined) r.startNumber = startNum;
    for (let p = 1; p <= r.seats; p++) {
      // ID interno stabile (indice 1..N) per non rompere le prenotazioni esistenti
      const id = `F${r.id}-P${p}`;
      const displayPosto = startNum + p - 1;
      if (db.seats[id]) {
        newSeats[id] = db.seats[id];
        newSeats[id].posto = displayPosto; // aggiorna numerazione visualizzata
        newSeats[id].fila = r.id;
      } else {
        newSeats[id] = { id, fila: r.id, posto: displayPosto, status: 'available' };
      }
    }
    if (!db.prices[r.id]) {
      db.prices[r.id] = { giornaliera: 40, scontoSettimanale: 10, scontoQuindicinale: 15, scontoMensile: 20 };
    }
  }
  // Keep blocked status for seats that still exist
  db.seats = newSeats;
}

// ---- API Router ----
async function handleAPI(req, res, pathname, query) {
  const method = req.method;
  if (method === 'OPTIONS') return send(res, 204, '');

  if (pathname === '/api/health' && method === 'GET') {
    return send(res, 200, {
      status: 'ok',
      time: new Date().toISOString(),
      stripe: STRIPE_OK ? (STRIPE_LIVE ? 'live' : 'test') : 'demo-mode',
      email: smtpConfigured() ? 'smtp' : 'demo-log'
    });
  }

  // ========== PUBLIC SETTINGS ==========
  if (pathname === '/api/settings' && method === 'GET') {
    const s = getSettings();
    return send(res, 200, {
      beachName: s.beachName,
      bannerEnabled: s.bannerEnabled,
      bannerText: s.bannerText,
      bannerBg: s.bannerBg,
      bannerColor: s.bannerColor,
      paymentCash: s.paymentCash,
      paymentSatispay: s.paymentSatispay,
      paymentStripe: s.paymentStripe !== false,
      satispayQrUrl: s.satispayQrUrl,
      satispayNote: s.satispayNote,
      cancellationPenalty: s.cancellationPenalty,
      beachMapUrl: s.beachMapUrl || null,
      refundNoticeEnabled: s.refundNoticeEnabled !== false,
      refundNoticeText: s.refundNoticeText || ''
    });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const { json: body } = await readBody(req);
    const s = getSettings();
    if (body.beachName !== undefined) s.beachName = String(body.beachName).trim() || 'Spiaggia Blu';
    if (body.bannerEnabled !== undefined) s.bannerEnabled = !!body.bannerEnabled;
    if (body.bannerText !== undefined) s.bannerText = String(body.bannerText);
    if (body.bannerBg !== undefined) s.bannerBg = String(body.bannerBg);
    if (body.bannerColor !== undefined) s.bannerColor = String(body.bannerColor);
    if (body.cancellationPenalty !== undefined) s.cancellationPenalty = Math.max(0, parseFloat(body.cancellationPenalty) || 0);
    if (body.paymentCash !== undefined) s.paymentCash = !!body.paymentCash;
    if (body.paymentSatispay !== undefined) s.paymentSatispay = !!body.paymentSatispay;
    if (body.paymentStripe !== undefined) s.paymentStripe = !!body.paymentStripe;
    if (body.satispayNote !== undefined) s.satispayNote = String(body.satispayNote);
    if (body.refundNoticeEnabled !== undefined) s.refundNoticeEnabled = !!body.refundNoticeEnabled;
    if (body.refundNoticeText !== undefined) s.refundNoticeText = String(body.refundNoticeText);
    db.settings = s;
    saveDB();
    return send(res, 200, { ok: true, settings: s });
  }

  // Upload Satispay QR
  if (pathname === '/api/settings/satispay-qr' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const bodyData = await readBody(req);
    if (!bodyData.multipart) return send(res, 400, { error: 'Multipart richiesto.' });
    const parsed = parseMultipart(bodyData.raw, bodyData.contentType);
    if (!parsed || !parsed.files.qr) return send(res, 400, { error: 'File QR mancante (campo "qr").' });
    const file = parsed.files.qr;
    const ext = path.extname(file.filename).toLowerCase() || '.png';
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      return send(res, 400, { error: 'Formato non supportato. Usa PNG/JPG/WEBP.' });
    }
    fs.mkdirSync(UPLOADS, { recursive: true });
    const fname = 'satispay-qr' + ext;
    fs.writeFileSync(path.join(UPLOADS, fname), file.data);
    const s = getSettings();
    s.satispayQrUrl = '/uploads/' + fname + '?t=' + Date.now();
    db.settings = s;
    saveDB();
    return send(res, 200, { ok: true, url: s.satispayQrUrl });
  }

  // Upload planimetria spiaggia (foto disposizione ombrelloni)
  if (pathname === '/api/settings/beach-map' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const bodyData = await readBody(req);
    if (!bodyData.multipart) return send(res, 400, { error: 'Multipart richiesto.' });
    const parsed = parseMultipart(bodyData.raw, bodyData.contentType);
    if (!parsed || !parsed.files.map) return send(res, 400, { error: 'File mappa mancante (campo "map").' });
    const file = parsed.files.map;
    const ext = path.extname(file.filename).toLowerCase() || '.png';
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      return send(res, 400, { error: 'Formato non supportato. Usa PNG/JPG/WEBP.' });
    }
    fs.mkdirSync(UPLOADS, { recursive: true });
    const fname = 'beach-map' + ext;
    fs.writeFileSync(path.join(UPLOADS, fname), file.data);
    const s = getSettings();
    s.beachMapUrl = '/uploads/' + fname + '?t=' + Date.now();
    db.settings = s;
    saveDB();
    return send(res, 200, { ok: true, url: s.beachMapUrl });
  }

  // Elimina planimetria
  if (pathname === '/api/settings/beach-map' && method === 'DELETE') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const s = getSettings();
    s.beachMapUrl = null;
    db.settings = s;
    saveDB();
    return send(res, 200, { ok: true });
  }

  // ========== AUTH ==========
  if (pathname === '/api/auth/register' && method === 'POST') {
    const { json: body } = await readBody(req);
    const { email, password, nome, telefono } = body;
    if (!email || !password || !nome) return send(res, 400, { error: 'Email, password e nome obbligatori.' });
    if (!telefono || String(telefono).trim().length < 6) {
      return send(res, 400, { error: 'Numero di telefono obbligatorio.' });
    }
    if (password.length < 6) return send(res, 400, { error: 'Password min. 6 caratteri.' });
    if (db.users.find(u => u.email === email.toLowerCase())) return send(res, 409, { error: 'Email già registrata.' });
    const user = {
      id: db._seq++, email: email.toLowerCase(), password_hash: hashPassword(password),
      nome: nome.trim(), telefono: String(telefono).trim(), role: 'user', created_at: new Date().toISOString()
    };
    db.users.push(user); saveDB();
    const token = signJWT({ id: user.id, email: user.email, role: user.role, nome: user.nome });
    return send(res, 201, { token, user: { id: user.id, email: user.email, nome: user.nome, telefono: user.telefono, role: user.role } });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const { json: body } = await readBody(req);
    const user = db.users.find(u => u.email === (body.email || '').toLowerCase());
    if (!user || !verifyPassword(body.password || '', user.password_hash)) {
      return send(res, 401, { error: 'Credenziali non valide.' });
    }
    const token = signJWT({ id: user.id, email: user.email, role: user.role, nome: user.nome });
    return send(res, 200, { token, user: { id: user.id, email: user.email, nome: user.nome, telefono: user.telefono, role: user.role } });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    const user = db.users.find(u => u.id === auth.id);
    if (!user) return send(res, 404, { error: 'Utente non trovato.' });
    return send(res, 200, { user: { id: user.id, email: user.email, nome: user.nome, telefono: user.telefono, role: user.role } });
  }

  // ========== ROWS (file dinamiche) ==========
  if (pathname === '/api/rows' && method === 'GET') {
    const rows = [...(db.rows || [])].sort((a, b) => (a.order || a.id) - (b.order || b.id));
    return send(res, 200, { rows });
  }

  if (pathname === '/api/rows' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const { json: body } = await readBody(req);
    const name = (body.name || '').trim() || 'Nuova file';
    const seats = Math.min(Math.max(parseInt(body.seats) || 12, 1), 50);
    const startNumber = Math.max(1, parseInt(body.startNumber) || 1);
    const maxId = (db.rows || []).reduce((m, r) => Math.max(m, r.id), 0);
    const id = maxId + 1;
    const order = (db.rows || []).length + 1;
    const row = { id, name, seats, order, startNumber };
    if (!db.rows) db.rows = [];
    db.rows.push(row);
    if (!db.prices[id]) {
      db.prices[id] = { giornaliera: 40, scontoSettimanale: 10, scontoQuindicinale: 15, scontoMensile: 20 };
    }
    rebuildSeatsFromRows();
    saveDB();
    return send(res, 201, { row });
  }

  const rowMatch = pathname.match(/^\/api\/rows\/(\d+)$/);
  if (rowMatch && method === 'PUT') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const rowId = parseInt(rowMatch[1], 10);
    const row = (db.rows || []).find(r => r.id === rowId);
    if (!row) return send(res, 404, { error: 'File non trovata.' });
    const { json: body } = await readBody(req);
    if (body.name !== undefined) row.name = String(body.name).trim() || row.name;
    if (body.seats !== undefined) {
      const seats = Math.min(Math.max(parseInt(body.seats) || row.seats, 1), 50);
      // Check if reducing seats would remove occupied ones
      if (seats < row.seats) {
        for (let p = seats + 1; p <= row.seats; p++) {
          const sid = `F${rowId}-P${p}`;
          const hasBooking = db.bookings.some(b => b.seat_id === sid && b.status !== 'cancelled');
          if (hasBooking) {
            return send(res, 400, { error: `Impossibile ridurre: posto ${sid} ha prenotazioni attive.` });
          }
        }
      }
      row.seats = seats;
    }
    if (body.startNumber !== undefined) {
      row.startNumber = Math.max(1, parseInt(body.startNumber) || 1);
    }
    if (body.order !== undefined) row.order = parseInt(body.order) || row.order;
    rebuildSeatsFromRows();
    saveDB();
    return send(res, 200, { row });
  }

  if (rowMatch && method === 'DELETE') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const rowId = parseInt(rowMatch[1], 10);
    const idx = (db.rows || []).findIndex(r => r.id === rowId);
    if (idx < 0) return send(res, 404, { error: 'File non trovata.' });
    const hasBooking = db.bookings.some(b => b.fila === rowId && b.status !== 'cancelled');
    if (hasBooking) return send(res, 400, { error: 'Impossibile eliminare: ci sono prenotazioni attive su questa file.' });
    db.rows.splice(idx, 1);
    delete db.prices[rowId];
    rebuildSeatsFromRows();
    saveDB();
    return send(res, 200, { ok: true });
  }

  // ========== SEASONS ==========
  if (pathname === '/api/seasons' && method === 'GET') {
    const all = query.get('all') === '1';
    let seasons = db.seasons || [];
    if (!all) seasons = seasons.filter(s => s.active);
    seasons = [...seasons].sort((a, b) => a.start.localeCompare(b.start));
    return send(res, 200, { seasons });
  }

  if (pathname === '/api/seasons' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const { json: body } = await readBody(req);
    const { name, start, end, active } = body;
    if (!name || !start || !end) return send(res, 400, { error: 'name, start, end obbligatori.' });
    if (start > end) return send(res, 400, { error: 'Data inizio deve essere prima della fine.' });
    const id = 'S' + Date.now().toString(36).toUpperCase();
    const season = { id, name: name.trim(), start, end, active: active !== false };
    db.seasons.push(season); saveDB();
    return send(res, 201, { season });
  }

  const seasonMatch = pathname.match(/^\/api\/seasons\/([^/]+)$/);
  if (seasonMatch && method === 'PUT') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const season = getSeason(seasonMatch[1]);
    if (!season) return send(res, 404, { error: 'Stagione non trovata.' });
    const { json: body } = await readBody(req);
    if (body.name !== undefined) season.name = body.name.trim();
    if (body.start !== undefined) season.start = body.start;
    if (body.end !== undefined) season.end = body.end;
    if (body.active !== undefined) season.active = !!body.active;
    if (season.start > season.end) return send(res, 400, { error: 'Date non valide.' });
    saveDB();
    return send(res, 200, { season });
  }

  if (seasonMatch && method === 'DELETE') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const idx = (db.seasons || []).findIndex(s => s.id === seasonMatch[1]);
    if (idx < 0) return send(res, 404, { error: 'Stagione non trovata.' });
    const hasBookings = db.bookings.some(b => b.season_id === seasonMatch[1] && b.status !== 'cancelled');
    if (hasBookings) return send(res, 400, { error: 'Impossibile eliminare: ci sono prenotazioni attive su questa stagione.' });
    db.seasons.splice(idx, 1); saveDB();
    return send(res, 200, { ok: true });
  }

  // Calendar
  if (pathname === '/api/calendar' && method === 'GET') {
    const seasonId = query.get('season');
    const seatId = query.get('seat');
    const season = seasonId ? getSeason(seasonId) : null;
    if (!season) return send(res, 400, { error: 'season obbligatorio.' });

    const days = {};
    let d = season.start;
    while (d <= season.end) {
      days[d] = { date: d, occupied: 0, total: 0, free: 0 };
      d = addDays(d, 1);
    }

    const seatsList = Object.values(db.seats).filter(s => s.status !== 'blocked');
    const totalSeats = seatsList.length || 1;

    for (const b of db.bookings) {
      if (b.status === 'cancelled') continue;
      if (seasonId && b.season_id && b.season_id !== seasonId) continue;
      if (seatId && b.seat_id !== seatId) continue;
      let cur = b.data_inizio;
      while (cur <= b.data_fine) {
        if (days[cur]) {
          if (seatId) days[cur].occupied = 1;
          else days[cur].occupied++;
        }
        cur = addDays(cur, 1);
      }
    }

    Object.keys(days).forEach(k => {
      days[k].total = seatId ? 1 : totalSeats;
      days[k].free = Math.max(0, days[k].total - days[k].occupied);
      days[k].pct = days[k].total ? Math.round((days[k].occupied / days[k].total) * 100) : 0;
    });

    return send(res, 200, { season, days: Object.values(days) });
  }

  // ========== SEATS ==========
  if (pathname === '/api/seats' && method === 'GET') {
    const start = query.get('start'), end = query.get('end');
    const seats = Object.values(db.seats).map(s => {
      let status = s.status;
      if (status !== 'blocked' && start && end) {
        // Check confirmed/paid vs pending
        const overlapping = db.bookings.filter(b =>
          b.seat_id === s.id && b.status !== 'cancelled' &&
          b.data_inizio <= end && b.data_fine >= start
        );
        if (overlapping.some(b => b.status === 'confirmed' || b.status === 'paid')) {
          status = 'occupied';
        } else if (overlapping.some(b => b.status === 'pending' || b.status === 'awaiting_payment')) {
          status = 'pending';
        } else {
          status = 'available';
        }
      } else if (status !== 'blocked') {
        status = 'available';
      }
      const occupancies = getSeatOccupancies(s.id);
      return { id: s.id, fila: s.fila, posto: s.posto, status, occupancies };
    }).sort((a, b) => a.fila - b.fila || a.posto - b.posto);
    return send(res, 200, { seats, rows: db.rows || [] });
  }

  const seatToggle = pathname.match(/^\/api\/seats\/([^/]+)\/toggle-block$/);
  if (seatToggle && method === 'PATCH') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    if (auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const seat = db.seats[seatToggle[1]];
    if (!seat) return send(res, 404, { error: 'Posto non trovato.' });
    if (seat.status === 'blocked') {
      seat.status = 'available'; saveDB();
      return send(res, 200, { id: seat.id, status: 'available' });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (db.bookings.some(b => b.seat_id === seat.id && b.status !== 'cancelled' && b.data_fine >= today)) {
      return send(res, 400, { error: 'Impossibile bloccare: prenotazioni future presenti.' });
    }
    seat.status = 'blocked'; saveDB();
    return send(res, 200, { id: seat.id, status: 'blocked' });
  }

  // ========== PRICES ==========
  if (pathname === '/api/prices' && method === 'GET') {
    return send(res, 200, { prices: db.prices });
  }
  if (pathname === '/api/prices' && method === 'PUT') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const { json: body } = await readBody(req);
    if (!body.prices) return send(res, 400, { error: 'Formato non valido.' });
    for (const [fila, p] of Object.entries(body.prices)) {
      db.prices[fila] = {
        giornaliera: parseFloat(p.giornaliera) || 0,
        scontoSettimanale: parseFloat(p.scontoSettimanale) || 0,
        scontoQuindicinale: parseFloat(p.scontoQuindicinale) || 0,
        scontoMensile: parseFloat(p.scontoMensile) || 0
      };
    }
    saveDB();
    return send(res, 200, { ok: true, message: 'Prezzi aggiornati.' });
  }

  // ========== BOOKINGS ==========
  if (pathname === '/api/bookings' && method === 'GET') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    let bookings;
    if (auth.role === 'admin' && query.get('all') === '1') {
      bookings = db.bookings.map(b => {
        const u = db.users.find(x => x.id === b.user_id);
        const s = getSeason(b.season_id);
        return {
          ...b,
          user_nome: u?.nome, user_email: u?.email, user_telefono: u?.telefono,
          season_name: s?.name
        };
      }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else {
      bookings = db.bookings.filter(b => b.user_id === auth.id)
        .map(b => ({ ...b, season_name: getSeason(b.season_id)?.name }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return send(res, 200, { bookings });
  }

  if (pathname === '/api/bookings' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante. Effettua il login.' });
    const { json: body } = await readBody(req);
    const { seatId, package: pkg, dataInizio, numGiorni, seasonId, paymentMethod } = body;
    if (!seatId || !pkg || !dataInizio || !seasonId) {
      return send(res, 400, { error: 'seatId, package, dataInizio e seasonId obbligatori.' });
    }
    if (!['giornaliera', 'settimanale', 'quindicinale', 'mensile'].includes(pkg)) {
      return send(res, 400, { error: 'Pacchetto non valido.' });
    }
    const settings = getSettings();
    const pm = paymentMethod || 'stripe';
    if (!['stripe', 'satispay', 'cash'].includes(pm)) {
      return send(res, 400, { error: 'Metodo di pagamento non valido.' });
    }
    if (pm === 'cash' && !settings.paymentCash) return send(res, 400, { error: 'Pagamento contanti non abilitato.' });
    if (pm === 'satispay' && !settings.paymentSatispay) return send(res, 400, { error: 'Pagamento Satispay non abilitato.' });
    if (pm === 'stripe' && settings.paymentStripe === false) return send(res, 400, { error: 'Pagamento carta non abilitato.' });

    const season = getSeason(seasonId);
    if (!season || !season.active) return send(res, 400, { error: 'Stagione non valida o non attiva.' });

    const giorni = pkg === 'giornaliera'
      ? Math.min(Math.max(parseInt(numGiorni) || 1, 1), 30)
      : PACKAGE_DAYS[pkg];
    const dataFine = addDays(dataInizio, giorni - 1);

    if (!isDateInSeason(dataInizio, season) || !isDateInSeason(dataFine, season)) {
      return send(res, 400, {
        error: `Le date devono rientrare nella stagione "${season.name}" (${season.start} → ${season.end}).`
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (dataInizio < today) return send(res, 400, { error: 'Data nel passato.' });
    if (!isSeatFree(seatId, dataInizio, dataFine)) {
      return send(res, 409, { error: 'Posto non disponibile per le date selezionate.' });
    }

    const fila = parseInt(seatId.split('-')[0].replace('F', ''), 10);
    let status = 'pending';
    if (pm === 'cash') status = 'awaiting_payment'; // paga all'arrivo
    if (pm === 'satispay') status = 'awaiting_payment';

    const booking = {
      id: uid(), user_id: auth.id, seat_id: seatId, fila, package: pkg,
      season_id: seasonId, data_inizio: dataInizio, data_fine: dataFine, giorni,
      prezzo: calcPrice(fila, pkg, giorni), status,
      payment_method: pm,
      stripe_session_id: null, stripe_payment_intent: null,
      satispay_verified: false,
      penalty_applied: 0,
      created_at: new Date().toISOString()
    };
    db.bookings.push(booking); saveDB();
    return send(res, 201, { booking });
  }

  // Cancel with optional penalty
  const cancelMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    const booking = db.bookings.find(b => b.id === cancelMatch[1]);
    if (!booking) return send(res, 404, { error: 'Prenotazione non trovata.' });
    if (booking.user_id !== auth.id && auth.role !== 'admin') return send(res, 403, { error: 'Non autorizzato.' });
    if (booking.status === 'cancelled') return send(res, 400, { error: 'Già cancellata.' });

    const settings = getSettings();
    const { json: body } = await readBody(req).catch(() => ({ json: {} }));
    let penalty = 0;
    // Penalty for paid methods (stripe confirmed or satispay verified)
    const wasPaid = booking.status === 'confirmed' || booking.status === 'paid' ||
      (booking.payment_method === 'satispay' && booking.satispay_verified);
    if (wasPaid && booking.payment_method !== 'cash' && auth.role !== 'admin') {
      penalty = settings.cancellationPenalty || 0;
    }
    // Admin can override penalty
    if (auth.role === 'admin' && body.penalty !== undefined) {
      penalty = Math.max(0, parseFloat(body.penalty) || 0);
    }

    booking.status = 'cancelled';
    booking.penalty_applied = penalty;
    booking.cancelled_at = new Date().toISOString();
    saveDB();
    return send(res, 200, {
      ok: true,
      message: penalty > 0
        ? `Prenotazione cancellata. Penale applicata: € ${penalty.toFixed(2)}`
        : 'Prenotazione cancellata.',
      penalty
    });
  }

  // Admin: verify Satispay payment
  const verifySatispayMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/verify-satispay$/);
  if (verifySatispayMatch && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const booking = db.bookings.find(b => b.id === verifySatispayMatch[1]);
    if (!booking) return send(res, 404, { error: 'Prenotazione non trovata.' });
    if (booking.payment_method !== 'satispay') return send(res, 400, { error: 'Non è un pagamento Satispay.' });
    if (booking.status === 'cancelled') return send(res, 400, { error: 'Prenotazione cancellata.' });
    booking.status = 'confirmed';
    booking.satispay_verified = true;
    booking.verified_at = new Date().toISOString();
    saveDB();
    await notifyBookingConfirmed(booking);
    return send(res, 200, { ok: true, booking, message: 'Pagamento Satispay verificato e prenotazione confermata.' });
  }

  // Admin: confirm cash payment
  const confirmCashMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/confirm-cash$/);
  if (confirmCashMatch && method === 'POST') {
    const auth = getAuth(req);
    if (!auth || auth.role !== 'admin') return send(res, 403, { error: 'Solo admin.' });
    const booking = db.bookings.find(b => b.id === confirmCashMatch[1]);
    if (!booking) return send(res, 404, { error: 'Prenotazione non trovata.' });
    if (booking.payment_method !== 'cash') return send(res, 400, { error: 'Non è un pagamento contanti.' });
    if (booking.status === 'cancelled') return send(res, 400, { error: 'Prenotazione cancellata.' });
    booking.status = 'confirmed';
    booking.verified_at = new Date().toISOString();
    saveDB();
    await notifyBookingConfirmed(booking);
    return send(res, 200, { ok: true, booking, message: 'Pagamento contanti confermato.' });
  }

  // ========== PAYMENTS ==========
  if (pathname === '/api/payments/config' && method === 'GET') {
    const s = getSettings();
    return send(res, 200, {
      mode: STRIPE_OK ? (STRIPE_LIVE ? 'live' : 'test') : 'demo',
      publishableKey: STRIPE_OK ? STRIPE_PK : null,
      paymentCash: s.paymentCash,
      paymentSatispay: s.paymentSatispay,
      paymentStripe: s.paymentStripe !== false,
      satispayQrUrl: s.satispayQrUrl,
      satispayNote: s.satispayNote
    });
  }

  if (pathname === '/api/payments/create-checkout' && method === 'POST') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    const { json: body } = await readBody(req);
    const booking = db.bookings.find(b => b.id === body.bookingId);
    if (!booking) return send(res, 404, { error: 'Prenotazione non trovata.' });
    if (booking.user_id !== auth.id) return send(res, 403, { error: 'Non autorizzato.' });
    if (booking.status === 'confirmed' || booking.status === 'paid') {
      return send(res, 400, { error: 'Prenotazione già processata.' });
    }

    // Cash or Satispay: just return instructions
    if (booking.payment_method === 'cash') {
      return send(res, 200, {
        mode: 'cash',
        success: true,
        bookingId: booking.id,
        message: 'Prenotazione registrata. Paga in contanti all\'arrivo in spiaggia.',
        booking
      });
    }

    if (booking.payment_method === 'satispay') {
      const s = getSettings();
      return send(res, 200, {
        mode: 'satispay',
        success: true,
        bookingId: booking.id,
        message: 'Prenotazione registrata. Completa il pagamento con Satispay.',
        qrUrl: s.satispayQrUrl,
        note: s.satispayNote,
        booking,
        paymentLink: `${FRONTEND_URL}/?satispay=${booking.id}`
      });
    }

    // Stripe / demo
    if (!STRIPE_OK) {
      booking.status = 'confirmed';
      booking.stripe_session_id = 'demo_' + Date.now();
      saveDB();
      await notifyBookingConfirmed(booking);
      return send(res, 200, {
        mode: 'demo', success: true, bookingId: booking.id,
        message: 'Pagamento demo completato. Prenotazione confermata.',
        email: smtpConfigured() ? 'sent' : 'demo-log'
      });
    }

    try {
      const session = await stripeRequest('POST', '/v1/checkout/sessions', {
        'mode': 'payment',
        'payment_method_types[0]': 'card',
        'customer_email': auth.email,
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][product_data][name]': `Prenotazione ${booking.seat_id}`,
        'line_items[0][price_data][product_data][description]':
          `${booking.package} · ${booking.data_inizio} → ${booking.data_fine} (${booking.giorni} gg)`,
        'line_items[0][price_data][unit_amount]': String(Math.round(booking.prezzo * 100)),
        'line_items[0][quantity]': '1',
        'metadata[bookingId]': booking.id,
        'metadata[userId]': String(auth.id),
        'success_url': `${FRONTEND_URL}/?payment=success&booking=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${FRONTEND_URL}/?payment=cancelled&booking=${booking.id}`
      });

      booking.stripe_session_id = session.id;
      saveDB();
      return send(res, 200, { mode: STRIPE_LIVE ? 'live' : 'test', sessionId: session.id, url: session.url });
    } catch (err) {
      console.error('Stripe error:', err.message);
      return send(res, 500, { error: 'Errore Stripe: ' + err.message });
    }
  }

  if (pathname === '/api/payments/verify-session' && method === 'GET') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    const bookingId = query.get('booking');
    const sessionId = query.get('session_id');
    const booking = db.bookings.find(b => b.id === bookingId);
    if (!booking || booking.user_id !== auth.id) return send(res, 404, { error: 'Non trovata.' });

    if (booking.status === 'confirmed' || booking.status === 'paid') {
      return send(res, 200, { status: 'confirmed', booking });
    }

    if (STRIPE_OK && sessionId) {
      try {
        const session = await stripeRequest('GET', '/v1/checkout/sessions/' + sessionId);
        if (session.payment_status === 'paid') {
          booking.status = 'confirmed';
          booking.stripe_payment_intent = session.payment_intent || null;
          saveDB();
          await notifyBookingConfirmed(booking);
          return send(res, 200, { status: 'confirmed', booking });
        }
        return send(res, 200, { status: session.payment_status, booking });
      } catch (err) {
        return send(res, 500, { error: err.message });
      }
    }
    return send(res, 200, { status: booking.status, booking });
  }

  // Stripe Webhook
  if (pathname === '/api/payments/webhook' && method === 'POST') {
    const { raw } = await readBody(req);
    const sig = req.headers['stripe-signature'];
    let event;

    if (STRIPE_WHSEC && !STRIPE_WHSEC.includes('PLACEHOLDER') && sig) {
      event = verifyStripeSignature(raw, sig);
      if (!event) return send(res, 400, { error: 'Firma webhook non valida.' });
    } else {
      try { event = JSON.parse(raw); } catch { return send(res, 400, { error: 'Body non valido.' }); }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = session.metadata && session.metadata.bookingId;
      if (bookingId) {
        const booking = db.bookings.find(b => b.id === bookingId);
        if (booking && (booking.status === 'pending' || booking.status === 'awaiting_payment')) {
          booking.status = 'confirmed';
          booking.stripe_payment_intent = session.payment_intent || null;
          booking.stripe_session_id = session.id;
          saveDB();
          console.log(`✓ Prenotazione ${bookingId} confermata via webhook`);
          await notifyBookingConfirmed(booking);
        }
      }
    }
    return send(res, 200, { received: true });
  }

  // ========== EXPORT CSV ==========
  if (pathname === '/api/bookings/export' && method === 'GET') {
    const auth = getAuth(req);
    if (!auth) return send(res, 401, { error: 'Token mancante.' });
    let bookings;
    if (auth.role === 'admin' && query.get('all') === '1') {
      bookings = [...db.bookings];
    } else {
      bookings = db.bookings.filter(b => b.user_id === auth.id);
    }
    const status = query.get('status');
    const seasonId = query.get('season');
    if (status) bookings = bookings.filter(b => b.status === status);
    if (seasonId) bookings = bookings.filter(b => b.season_id === seasonId);
    bookings.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const csv = bookingsToCsv(bookings);
    const filename = auth.role === 'admin' && query.get('all') === '1'
      ? 'prenotazioni-tutte.csv'
      : 'mie-prenotazioni.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end('\ufeff' + csv);
    return;
  }

  return send(res, 404, { error: 'Endpoint non trovato.' });
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(FRONTEND, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(FRONTEND)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(FRONTEND, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

seed();
fs.mkdirSync(UPLOADS, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api')) {
      await handleAPI(req, res, url.pathname, url.searchParams);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Errore interno del server.' });
  }
});

// Su Render e altri host cloud ascolta su tutte le interfacce
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.FRONTEND_URL || `http://localhost:${PORT}`;
  console.log(`\n🏖️  Spiaggia Blu su ${publicUrl}`);
  console.log(`   Bind: ${HOST}:${PORT}`);
  console.log(`   Stripe: ${STRIPE_OK ? (STRIPE_LIVE ? 'LIVE 🔴' : 'TEST 🟡') : 'DEMO (inserisci chiavi in .env)'}`);
  console.log(`   Admin: admin@spiaggiablu.it / Admin123!`);
  console.log(`   User:  mario@email.com / User123!\n`);
});
