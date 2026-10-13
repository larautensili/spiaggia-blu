/**
 * Email – conferma cliente + notifica admin
 * SMTP Gmail (STARTTLS :587) o log demo se non configurato
 */
const net = require('net');
const tls = require('tls');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, ''); // Gmail app password may have spaces
const SMTP_FROM = process.env.SMTP_FROM || 'Spiaggia Blu <noreply@spiaggiablu.it>';
const ADMIN_NOTIFY = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || '';

function smtpConfigured() {
  // Considera non configurato se placeholder
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return false;
  if (SMTP_USER.includes('tua.email') || SMTP_PASS.includes('xxxx')) return false;
  return true;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encodeSubject(str) {
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function statusLabel(status) {
  return ({
    pending: 'In attesa di pagamento',
    confirmed: 'Confermata',
    paid: 'Pagata',
    cancelled: 'Cancellata'
  })[status] || status;
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = '----=_SB_' + Date.now().toString(36);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

function readSmtpCode(sock, codes) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP timeout'));
    }, 25000);

    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
    }

    function onData(chunk) {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{3} /.test(lines[i])) {
          cleanup();
          const line = lines[i];
          buf = lines.slice(i + 1).join('\n');
          const code = parseInt(line.slice(0, 3), 10);
          if (!codes.includes(code)) return reject(new Error(`SMTP ${line}`));
          return resolve({ code, line });
        }
      }
    }
    sock.on('data', onData);
  });
}

async function sendViaSmtp({ to, subject, text, html }) {
  const fromAddr = (SMTP_FROM.match(/<([^>]+)>/) || [null, SMTP_FROM])[1];
  const mime = buildMime({ from: SMTP_FROM, to, subject, text, html });

  let sock = await new Promise((resolve, reject) => {
    const s = net.connect({ host: SMTP_HOST, port: SMTP_PORT }, () => resolve(s));
    s.on('error', reject);
  });
  sock.setEncoding('utf8');

  try {
    await readSmtpCode(sock, [220]);
    sock.write('EHLO spiaggiablu.local\r\n');
    await readSmtpCode(sock, [250]);

    if (!SMTP_SECURE && SMTP_PORT !== 465) {
      sock.write('STARTTLS\r\n');
      await readSmtpCode(sock, [220]);
      sock = tls.connect({ socket: sock, servername: SMTP_HOST });
      sock.setEncoding('utf8');
      await new Promise((resolve, reject) => {
        sock.once('secureConnect', resolve);
        sock.once('error', reject);
      });
      sock.write('EHLO spiaggiablu.local\r\n');
      await readSmtpCode(sock, [250]);
    }

    if (SMTP_USER) {
      sock.write('AUTH LOGIN\r\n');
      await readSmtpCode(sock, [334]);
      sock.write(Buffer.from(SMTP_USER).toString('base64') + '\r\n');
      await readSmtpCode(sock, [334]);
      sock.write(Buffer.from(SMTP_PASS).toString('base64') + '\r\n');
      await readSmtpCode(sock, [235]);
    }

    sock.write(`MAIL FROM:<${fromAddr}>\r\n`);
    await readSmtpCode(sock, [250]);
    sock.write(`RCPT TO:<${to}>\r\n`);
    await readSmtpCode(sock, [250, 251]);
    sock.write('DATA\r\n');
    await readSmtpCode(sock, [354]);
    sock.write(mime.replace(/\r?\n\./g, '\r\n..') + '\r\n.\r\n');
    await readSmtpCode(sock, [250]);
    sock.write('QUIT\r\n');
    try { sock.end(); } catch {}
    return { ok: true, mode: 'smtp' };
  } catch (err) {
    try { sock.destroy(); } catch {}
    throw err;
  }
}

async function deliver(mail) {
  if (!smtpConfigured()) {
    console.log('\n📧 [DEMO EMAIL] → ' + mail.to);
    console.log('   Subject: ' + mail.subject);
    console.log(mail.text.split('\n').map(l => '   ' + l).join('\n'));
    console.log('');
    return { ok: true, mode: 'demo' };
  }
  try {
    const result = await sendViaSmtp(mail);
    console.log(`📧 Email inviata a ${mail.to}`);
    return result;
  } catch (err) {
    console.error('📧 Errore SMTP:', err.message);
    console.log('\n📧 [FALLBACK LOG] → ' + mail.to);
    console.log(mail.text);
    return { ok: false, mode: 'error', error: err.message };
  }
}

function customerEmail({ to, nome, booking, seasonName }) {
  const label = statusLabel(booking.status);
  const subject = `Conferma prenotazione ${booking.id} – Spiaggia Blu`;
  const text = [
    `Ciao ${nome},`,
    '',
    `la tua prenotazione è ${label.toLowerCase()}.`,
    '',
    'Dettagli:',
    `  ID:        ${booking.id}`,
    `  Posto:     ${booking.seat_id}`,
    `  Stagione:  ${seasonName || booking.season_id || '—'}`,
    `  Pacchetto: ${booking.package}`,
    `  Periodo:   ${booking.data_inizio} → ${booking.data_fine} (${booking.giorni} giorni)`,
    `  Importo:   € ${Number(booking.prezzo).toFixed(2)}`,
    `  Stato:     ${label}`,
    '',
    'Grazie per aver scelto Spiaggia Blu!',
    '',
    '— Spiaggia Blu · Prenotazioni stagionali'
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1a2b3c;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:linear-gradient(135deg,#0a7ea4,#2a9d8f);color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:22px">🏖️ Spiaggia Blu</h1>
    <p style="margin:6px 0 0;opacity:.9">Conferma prenotazione</p>
  </div>
  <div style="border:1px solid #d0e0e8;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p>Ciao <strong>${escapeHtml(nome)}</strong>,</p>
    <p>la tua prenotazione è <strong style="color:#2a9d8f">${escapeHtml(label)}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
      <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#6b7c8a">ID</td>
          <td style="padding:8px;border-bottom:1px solid #eee"><strong>${escapeHtml(booking.id)}</strong></td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#6b7c8a">Posto</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(booking.seat_id)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#6b7c8a">Stagione</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(seasonName || booking.season_id || '—')}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#6b7c8a">Pacchetto</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(booking.package)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#6b7c8a">Periodo</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(booking.data_inizio)} → ${escapeHtml(booking.data_fine)} (${booking.giorni} gg)</td></tr>
      <tr><td style="padding:8px;color:#6b7c8a">Importo</td>
          <td style="padding:8px"><strong style="color:#0a7ea4;font-size:18px">€ ${Number(booking.prezzo).toFixed(2)}</strong></td></tr>
    </table>
    <p style="color:#6b7c8a;font-size:13px">Grazie per aver scelto Spiaggia Blu.</p>
  </div>
</body></html>`;

  return { to, subject, text, html };
}

function adminEmail({ booking, customer, seasonName }) {
  const label = statusLabel(booking.status);
  const subject = `[Admin] Nuova prenotazione ${booking.id} – ${booking.seat_id}`;
  const text = [
    'Nuova prenotazione ricevuta.',
    '',
    `  ID:        ${booking.id}`,
    `  Cliente:   ${customer?.nome || '—'} <${customer?.email || '—'}>`,
    `  Telefono:  ${customer?.telefono || '—'}`,
    `  Posto:     ${booking.seat_id} (File ${booking.fila})`,
    `  Stagione:  ${seasonName || booking.season_id || '—'}`,
    `  Pacchetto: ${booking.package}`,
    `  Periodo:   ${booking.data_inizio} → ${booking.data_fine} (${booking.giorni} giorni)`,
    `  Importo:   € ${Number(booking.prezzo).toFixed(2)}`,
    `  Stato:     ${label}`,
    `  Creato:    ${booking.created_at || ''}`,
    '',
    '— Spiaggia Blu Admin'
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1a2b3c;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#1a2b3c;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:18px">🔔 Nuova prenotazione</h1>
  </div>
  <div style="border:1px solid #d0e0e8;border-top:none;padding:20px;border-radius:0 0 12px 12px">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px;color:#6b7c8a">ID</td><td style="padding:6px"><strong>${escapeHtml(booking.id)}</strong></td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Cliente</td><td style="padding:6px">${escapeHtml(customer?.nome)} &lt;${escapeHtml(customer?.email)}&gt;</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Telefono</td><td style="padding:6px">${escapeHtml(customer?.telefono || '—')}</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Posto</td><td style="padding:6px">${escapeHtml(booking.seat_id)} (File ${booking.fila})</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Stagione</td><td style="padding:6px">${escapeHtml(seasonName || '—')}</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Pacchetto</td><td style="padding:6px">${escapeHtml(booking.package)}</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Periodo</td><td style="padding:6px">${escapeHtml(booking.data_inizio)} → ${escapeHtml(booking.data_fine)}</td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Importo</td><td style="padding:6px"><strong>€ ${Number(booking.prezzo).toFixed(2)}</strong></td></tr>
      <tr><td style="padding:6px;color:#6b7c8a">Stato</td><td style="padding:6px">${escapeHtml(label)}</td></tr>
    </table>
  </div>
</body></html>`;

  return {
    to: ADMIN_NOTIFY,
    subject,
    text,
    html
  };
}

/** Email di conferma al cliente */
async function sendBookingConfirmation({ to, nome, booking, seasonName }) {
  return deliver(customerEmail({ to, nome, booking, seasonName }));
}

/** Notifica all'amministratore */
async function sendAdminNotification({ booking, customer, seasonName }) {
  const adminTo = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || ADMIN_NOTIFY;
  if (!adminTo || adminTo.includes('tua.email')) {
    console.log('📧 ADMIN_NOTIFY_EMAIL non impostata – skip notifica admin');
    return { ok: false, mode: 'skipped' };
  }
  const mail = adminEmail({ booking, customer, seasonName });
  mail.to = adminTo;
  return deliver(mail);
}

module.exports = {
  sendBookingConfirmation,
  sendAdminNotification,
  smtpConfigured
};
