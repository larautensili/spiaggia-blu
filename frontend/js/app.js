/**
 * Spiaggia Blu – Frontend
 * Auth · Multi-stagione · File dinamiche · Calendario · Stripe / Satispay / Contanti
 */
const API = '/api';
const CONFIG = {
  maxGiorniGiornaliera: 30,
  packageDays: { giornaliera: null, settimanale: 7, quindicinale: 15, mensile: 30 }
};

let state = {
  token: localStorage.getItem('sb_token') || null,
  user: JSON.parse(localStorage.getItem('sb_user') || 'null'),
  prezzi: {},
  seats: [],
  rows: [],
  seasons: [],
  settings: {},
  selectedSeasonId: null,
  selectedSeat: null,
  currentPackage: 'giornaliera',
  paymentMode: 'demo',
  paymentMethod: 'stripe'
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getSelectedSeason() {
  return state.seasons.find(s => s.id === state.selectedSeasonId);
}

function getRowName(filaId) {
  const r = state.rows.find(x => x.id === filaId || x.id === parseInt(filaId, 10));
  return r ? r.name : `File ${filaId}`;
}

// ---- Auth ----
function setAuth(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('sb_token', token);
    localStorage.setItem('sb_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
  }
  updateAuthUI();
}

function updateAuthUI() {
  const authArea = document.getElementById('auth-area');
  const userArea = document.getElementById('user-area');
  const navMie = document.getElementById('nav-mie');
  const navAdmin = document.getElementById('nav-admin');
  if (state.user) {
    authArea.style.display = 'none';
    userArea.style.display = 'flex';
    document.getElementById('user-name').textContent = state.user.nome;
    navMie.style.display = '';
    navAdmin.style.display = state.user.role === 'admin' ? '' : 'none';
  } else {
    authArea.style.display = 'flex';
    userArea.style.display = 'none';
    navMie.style.display = 'none';
    navAdmin.style.display = 'none';
  }
}

function showAuthModal(mode = 'login') {
  document.getElementById('auth-modal').style.display = 'flex';
  document.getElementById('login-form-wrap').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('register-form-wrap').style.display = mode === 'register' ? '' : 'none';
}
function hideAuthModal() { document.getElementById('auth-modal').style.display = 'none'; }

async function doLogin() {
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value
      })
    });
    setAuth(data.token, data.user);
    hideAuthModal();
    toast(`Bentornato, ${data.user.nome}!`);
  } catch (e) { toast(e.message, 'error'); }
}

async function doRegister() {
  try {
    const telefono = document.getElementById('reg-telefono').value.trim();
    if (!telefono || telefono.length < 6) {
      toast('Inserisci un numero di telefono valido', 'error');
      return;
    }
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('reg-nome').value.trim(),
        email: document.getElementById('reg-email').value.trim(),
        telefono,
        password: document.getElementById('reg-password').value
      })
    });
    setAuth(data.token, data.user);
    hideAuthModal();
    toast(`Benvenuto, ${data.user.nome}!`);
  } catch (e) { toast(e.message, 'error'); }
}

function logout() {
  setAuth(null, null);
  switchView('prenota');
  toast('Disconnesso');
}

// ---- Settings / Banner ----
async function loadSettings() {
  try {
    const s = await api('/settings');
    state.settings = s;
    applySettingsUI();
  } catch (e) { console.warn(e); }
}

function applySettingsUI() {
  const s = state.settings || {};
  const name = s.beachName || 'Spiaggia Blu';
  document.getElementById('beach-name').textContent = name;
  document.getElementById('footer-beach-name').textContent = name;
  document.title = name + ' – Prenotazioni Multi-Stagione';

  const banner = document.getElementById('promo-banner');
  if (s.bannerEnabled && s.bannerText) {
    banner.style.display = '';
    banner.style.background = s.bannerBg || '#0a7ea4';
    banner.style.color = s.bannerColor || '#ffffff';
    document.getElementById('promo-banner-text').textContent = s.bannerText;
  } else {
    banner.style.display = 'none';
  }

  // Payment options visibility
  const optStripe = document.querySelector('input[name="payment"][value="stripe"]')?.closest('.payment-option');
  const optSat = document.getElementById('pay-opt-satispay');
  const optCash = document.getElementById('pay-opt-cash');
  if (optStripe) optStripe.style.display = s.paymentStripe !== false ? '' : 'none';
  if (optSat) optSat.style.display = s.paymentSatispay ? '' : 'none';
  if (optCash) optCash.style.display = s.paymentCash ? '' : 'none';

  // Ensure a valid payment method is selected
  const checked = document.querySelector('input[name="payment"]:checked');
  if (checked && checked.closest('.payment-option')?.style.display === 'none') {
    const first = document.querySelector('.payment-option:not([style*="display: none"]) input[name="payment"]');
    if (first) first.checked = true;
  }

  // Avviso rimborso sotto metodi di pagamento
  const refundBox = document.getElementById('refund-notice');
  const refundText = document.getElementById('refund-notice-text');
  if (refundBox && refundText) {
    if (s.refundNoticeEnabled !== false && s.refundNoticeText) {
      const penale = Number(s.cancellationPenalty ?? 0).toFixed(2);
      refundText.textContent = String(s.refundNoticeText).replace(/\{penale\}/gi, penale);
      refundBox.style.display = '';
    } else {
      refundBox.style.display = 'none';
    }
  }

  // Planimetria sulla mappa pubblica (frontend)
  updatePublicPlanimetry();

  // Aggiorna preview planimetria admin se presente nel DOM
  if (typeof updateBeachMapPreview === 'function') updateBeachMapPreview();
}

// ---- Seasons ----
async function loadSeasons() {
  const { seasons } = await api('/seasons');
  state.seasons = seasons;
  if (!state.selectedSeasonId && seasons.length) {
    const today = new Date().toISOString().slice(0, 10);
    const current = seasons.find(s => s.start <= today && s.end >= today);
    const upcoming = seasons.find(s => s.start > today);
    state.selectedSeasonId = (current || upcoming || seasons[0]).id;
  }
  populateSeasonSelects();
  applySeasonDateLimits();
}

function populateSeasonSelects() {
  const opts = state.seasons.map(s =>
    `<option value="${s.id}" ${s.id === state.selectedSeasonId ? 'selected' : ''}>${s.name}</option>`
  ).join('');
  const sel = document.getElementById('season-select');
  const calSel = document.getElementById('cal-season');
  if (sel) sel.innerHTML = opts || '<option value="">Nessuna stagione</option>';
  if (calSel) {
    calSel.innerHTML = opts;
    if (state.selectedSeasonId) calSel.value = state.selectedSeasonId;
  }
  updateSeasonRangeLabel();
}

function updateSeasonRangeLabel() {
  const s = getSelectedSeason();
  const el = document.getElementById('season-range');
  if (el) el.textContent = s ? `${formatDate(s.start)} → ${formatDate(s.end)}` : '';
}

function applySeasonDateLimits() {
  const s = getSelectedSeason();
  const input = document.getElementById('data-inizio');
  if (!s || !input) return;
  const today = new Date().toISOString().slice(0, 10);
  input.min = s.start > today ? s.start : today;
  input.max = s.end;
  if (!input.value || input.value < input.min || input.value > input.max) {
    input.value = input.min;
  }
  updateDateFine();
}

// ---- Dates / package ----
function getNumDays() {
  if (state.currentPackage === 'giornaliera') {
    return Math.min(Math.max(parseInt(document.getElementById('num-giorni').value) || 1, 1), CONFIG.maxGiorniGiornaliera);
  }
  return CONFIG.packageDays[state.currentPackage];
}

function getDateRange() {
  const start = document.getElementById('data-inizio').value;
  if (!start) return null;
  const days = getNumDays();
  return { start, end: addDays(start, days - 1), days };
}

/**
 * Sconti progressivi giornaliera:
 * >= 7 → settimanale, >= 15 → quindicinale, >= 30 → mensile
 */
function calcPriceLocal(fila, packageType, numDays) {
  const p = state.prezzi[fila];
  if (!p) return 0;
  let total = p.giornaliera * numDays, sconto = 0;
  if (packageType === 'settimanale') sconto = p.scontoSettimanale;
  else if (packageType === 'quindicinale') sconto = p.scontoQuindicinale;
  else if (packageType === 'mensile') sconto = p.scontoMensile;
  else if (packageType === 'giornaliera') {
    if (numDays >= 30) sconto = p.scontoMensile;
    else if (numDays >= 15) sconto = p.scontoQuindicinale;
    else if (numDays >= 7) sconto = p.scontoSettimanale;
    else if (numDays >= 4) sconto = Math.min(5 + (numDays - 4) * 1.5, p.scontoSettimanale || 10);
  }
  return Math.round(total * (1 - sconto / 100) * 100) / 100;
}

function onPackageChange() {
  state.currentPackage = document.querySelector('input[name="package"]:checked').value;
  document.getElementById('giorni-container').style.display = state.currentPackage === 'giornaliera' ? 'block' : 'none';
  document.getElementById('data-fine-container').style.display = state.currentPackage === 'giornaliera' ? 'none' : 'block';
  updateDateFine();
  updateRiepilogo();
  state.selectedSeat = null;
  loadSeats();
}

function updateDateFine() {
  const range = getDateRange();
  const el = document.getElementById('data-fine');
  if (el) el.value = range ? `${formatDate(range.end)} (${range.days} giorni)` : '';
}

// ---- Seats map ----
async function loadSeats() {
  const range = getDateRange();
  const q = range ? `?start=${range.start}&end=${range.end}` : '';
  try {
    const data = await api('/seats' + q);
    state.seats = data.seats;
    if (data.rows) state.rows = data.rows;
    renderMap('beach-map');
  } catch (e) { console.error(e); }
}

function showSeatTooltip(e, seat) {
  const tip = document.getElementById('seat-tooltip');
  if (!seat.occupancies || !seat.occupancies.length) {
    tip.style.display = 'none';
    return;
  }
  const lines = seat.occupancies.map(o => {
    const st = o.status === 'pending' || o.status === 'awaiting_payment' ? 'in prenotazione' : 'occupato';
    return `${formatDate(o.start)} → ${formatDate(o.end)} (${st})`;
  });
  tip.innerHTML = `<strong>${seat.id}</strong>${lines.join('<br>')}`;
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 280) + 'px';
  tip.style.top = (e.clientY + 12) + 'px';
}

function hideSeatTooltip() {
  document.getElementById('seat-tooltip').style.display = 'none';
}

function renderMap(containerId, isAdmin = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const byFila = {};
  for (const s of state.seats) {
    if (!byFila[s.fila]) byFila[s.fila] = [];
    byFila[s.fila].push(s);
  }

  const rowsSorted = [...(state.rows || [])].sort((a, b) => (a.order || a.id) - (b.order || b.id));
  const filaIds = rowsSorted.length
    ? rowsSorted.map(r => r.id)
    : Object.keys(byFila).map(Number).sort((a, b) => a - b);

  let html = '<div class="sea-label">🌊  Mare  🌊</div>';
  for (const f of filaIds) {
    const rowName = getRowName(f);
    html += `<div class="row"><span class="row-label" title="${rowName}">${rowName}</span><div class="seats">`;
    for (const s of (byFila[f] || []).sort((a, b) => a.posto - b.posto)) {
      let cls = 'seat ' + (s.status || 'available');
      if (!isAdmin && state.selectedSeat === s.id && s.status === 'available') cls = 'seat selected';
      html += `<div class="${cls}" data-seat="${s.id}" title="${s.id}">${s.posto}</div>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html;

  container.querySelectorAll('.seat').forEach(el => {
    const id = el.dataset.seat;
    const seat = state.seats.find(s => s.id === id);

    el.addEventListener('mouseenter', (e) => {
      if (seat && (seat.status === 'occupied' || seat.status === 'pending' || (seat.occupancies && seat.occupancies.length))) {
        showSeatTooltip(e, seat);
      }
    });
    el.addEventListener('mousemove', (e) => {
      if (seat && (seat.status === 'occupied' || seat.status === 'pending' || (seat.occupancies && seat.occupancies.length))) {
        showSeatTooltip(e, seat);
      }
    });
    el.addEventListener('mouseleave', hideSeatTooltip);

    el.addEventListener('click', async () => {
      if (isAdmin) {
        if (!state.user || state.user.role !== 'admin') return;
        try {
          const data = await api(`/seats/${id}/toggle-block`, { method: 'PATCH' });
          toast(data.status === 'blocked' ? `Posto ${id} bloccato` : `Posto ${id} sbloccato`);
          await loadSeatsAdmin();
        } catch (e) { toast(e.message, 'error'); }
        return;
      }
      if (el.classList.contains('occupied') || el.classList.contains('blocked') || el.classList.contains('pending')) return;
      state.selectedSeat = id;
      renderMap('beach-map');
      updateRiepilogo();
    });
  });
}

async function loadSeatsAdmin() {
  try {
    const data = await api('/seats');
    state.seats = data.seats;
    if (data.rows) state.rows = data.rows;
    renderMap('admin-map', true);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Riepilogo & booking ----
function updateRiepilogo() {
  const box = document.getElementById('riepilogo');
  const btn = document.getElementById('btn-prenota');
  const hint = document.getElementById('pay-hint');
  const range = getDateRange();
  const season = getSelectedSeason();
  const pm = document.querySelector('input[name="payment"]:checked')?.value || 'stripe';
  state.paymentMethod = pm;

  if (!state.selectedSeat || !range || !season) {
    box.innerHTML = '<p class="muted">Seleziona stagione, posto e periodo</p>';
    btn.disabled = true;
    hint.textContent = '';
    return;
  }

  if (range.start < season.start || range.end > season.end) {
    box.innerHTML = `<p class="muted" style="color:var(--danger)">Le date devono rientrare in ${season.name}</p>`;
    btn.disabled = true;
    return;
  }

  const fila = parseInt(state.selectedSeat.split('-')[0].replace('F', ''));
  const prezzo = calcPriceLocal(fila, state.currentPackage, range.days);
  const pkgLabel = { giornaliera: 'Giornaliera', settimanale: 'Settimanale', quindicinale: 'Quindicinale', mensile: 'Mensile' }[state.currentPackage];
  const payLabel = { stripe: 'Carta', satispay: 'Satispay', cash: 'Contanti all\'arrivo' }[pm];

  let scontoNote = '';
  if (state.currentPackage === 'giornaliera') {
    if (range.days >= 30) scontoNote = ' (sconto mensile)';
    else if (range.days >= 15) scontoNote = ' (sconto quindicinale)';
    else if (range.days >= 7) scontoNote = ' (sconto settimanale)';
  }

  box.innerHTML = `
    <div class="price-line"><span>Stagione</span><strong>${season.name}</strong></div>
    <div class="price-line"><span>Posto</span><strong>${state.selectedSeat}</strong></div>
    <div class="price-line"><span>Pacchetto</span><strong>${pkgLabel}${scontoNote}</strong></div>
    <div class="price-line"><span>Periodo</span><strong>${formatDate(range.start)} → ${formatDate(range.end)}</strong></div>
    <div class="price-line"><span>Giorni</span><strong>${range.days}</strong></div>
    <div class="price-line"><span>Pagamento</span><strong>${payLabel}</strong></div>
    <div class="price-line total"><span>Totale</span><strong>€ ${prezzo.toFixed(2)}</strong></div>
  `;
  btn.disabled = false;

  const modeHints = {
    stripe: state.paymentMode === 'demo' ? 'Modalità demo: pagamento simulato' :
      (state.paymentMode === 'live' ? 'Stripe LIVE: pagamento reale' : 'Stripe TEST: Checkout sicuro'),
    satispay: 'Satispay: scansiona il QR e completa il pagamento',
    cash: 'Contanti: paga all\'arrivo in spiaggia'
  };
  hint.textContent = modeHints[pm] || modeHints.stripe;
}

async function creaPrenotazioneEPaga() {
  if (!state.user) {
    showAuthModal('login');
    toast('Accedi per prenotare', 'error');
    return;
  }
  const range = getDateRange();
  if (!state.selectedSeat || !range || !state.selectedSeasonId) {
    toast('Seleziona stagione, posto e periodo', 'error');
    return;
  }

  const btn = document.getElementById('btn-prenota');
  btn.disabled = true;
  btn.textContent = 'Elaborazione...';
  const pm = document.querySelector('input[name="payment"]:checked')?.value || 'stripe';

  try {
    const { booking } = await api('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        seatId: state.selectedSeat,
        package: state.currentPackage,
        dataInizio: range.start,
        numGiorni: range.days,
        seasonId: state.selectedSeasonId,
        paymentMethod: pm
      })
    });

    const pay = await api('/payments/create-checkout', {
      method: 'POST',
      body: JSON.stringify({ bookingId: booking.id })
    });

    if (pay.mode === 'demo') {
      toast(`Pagamento demo OK! Prenotazione ${booking.id} confermata`);
      state.selectedSeat = null;
      updateRiepilogo();
      await loadSeats();
      return;
    }

    if (pay.mode === 'cash') {
      toast(`Prenotazione ${booking.id} registrata. Paga in contanti all'arrivo.`);
      state.selectedSeat = null;
      updateRiepilogo();
      await loadSeats();
      switchView('mie-prenotazioni');
      return;
    }

    if (pay.mode === 'satispay') {
      showSatispayModal(booking, pay);
      state.selectedSeat = null;
      updateRiepilogo();
      await loadSeats();
      return;
    }

    if (pay.url) {
      window.location.href = pay.url;
      return;
    }
    toast('Sessione di pagamento creata');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.textContent = 'Prenota e paga';
    btn.disabled = false;
  }
}

// ---- Satispay modal ----
let currentSatispayBooking = null;

function showSatispayModal(booking, pay) {
  currentSatispayBooking = booking;
  document.getElementById('satispay-modal').style.display = 'flex';
  document.getElementById('satispay-booking-id').textContent = booking.id;
  document.getElementById('satispay-booking-info').textContent =
    `Posto ${booking.seat_id} · € ${Number(booking.prezzo).toFixed(2)} · ${formatDate(booking.data_inizio)} → ${formatDate(booking.data_fine)}`;
  document.getElementById('satispay-note').textContent = pay.note || state.settings.satispayNote || '';

  const img = document.getElementById('satispay-qr-img');
  const noQr = document.getElementById('satispay-no-qr');
  const qrUrl = pay.qrUrl || state.settings.satispayQrUrl;
  if (qrUrl) {
    img.src = qrUrl;
    img.style.display = 'block';
    noQr.style.display = 'none';
  } else {
    img.style.display = 'none';
    noQr.style.display = 'block';
  }
}

function hideSatispayModal() {
  document.getElementById('satispay-modal').style.display = 'none';
  currentSatispayBooking = null;
}

function copySatispayLink() {
  const id = currentSatispayBooking?.id || document.getElementById('satispay-booking-id').textContent;
  const link = `${window.location.origin}/?satispay=${id}`;
  navigator.clipboard.writeText(link).then(() => toast('Link copiato')).catch(() => {
    prompt('Copia il link:', link);
  });
}

// ---- Calendar ----
async function loadCalendar() {
  const seasonId = document.getElementById('cal-season').value || state.selectedSeasonId;
  if (!seasonId) return;
  try {
    const data = await api(`/calendar?season=${seasonId}`);
    renderCalendar(data);
  } catch (e) {
    document.getElementById('calendar-grid').innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

function renderCalendar(data) {
  const grid = document.getElementById('calendar-grid');
  if (!data.days || !data.days.length) {
    grid.innerHTML = '<p class="muted">Nessun dato</p>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const months = {};
  for (const day of data.days) {
    const m = day.date.slice(0, 7);
    if (!months[m]) months[m] = [];
    months[m].push(day);
  }

  const monthNames = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  let html = '';
  for (const [ym, days] of Object.entries(months)) {
    const [y, m] = ym.split('-');
    html += `<div class="cal-month-label">${monthNames[parseInt(m, 10) - 1]} ${y}</div>`;
    for (const d of days) {
      let cls = 'free';
      if (d.pct >= 100) cls = 'full';
      else if (d.pct >= 70) cls = 'high';
      else if (d.pct >= 30) cls = 'mid';
      if (d.date < today) cls += ' past';
      const dayNum = d.date.slice(8);
      html += `<div class="cal-day ${cls}" title="${formatDate(d.date)}: ${d.free}/${d.total} liberi (${d.pct}% occupati)">
        <span class="cal-day-num">${parseInt(dayNum, 10)}</span>
        <span class="cal-day-pct">${d.pct}%</span>
      </div>`;
    }
  }
  grid.innerHTML = html;
}

// ---- Bookings list ----
async function renderBookingsList(containerId, all = false) {
  const container = document.getElementById(containerId);
  if (!state.user) {
    container.innerHTML = '<div class="empty-state"><span>🔒</span><p>Accedi per vedere le prenotazioni</p></div>';
    return;
  }
  try {
    const { bookings } = await api('/bookings' + (all ? '?all=1' : ''));
    if (!bookings.length) {
      container.innerHTML = '<div class="empty-state"><span>🏖️</span><p>Nessuna prenotazione trovata</p></div>';
      return;
    }
    const penalty = state.settings.cancellationPenalty || 0;
    container.innerHTML = bookings.map(pr => {
      const isAdmin = all && state.user.role === 'admin';
      let actions = `<span class="price">€ ${Number(pr.prezzo).toFixed(2)}</span>`;
      if (pr.penalty_applied > 0) {
        actions += `<span class="muted" style="font-size:0.75rem">Penale: € ${Number(pr.penalty_applied).toFixed(2)}</span>`;
      }
      if (pr.status !== 'cancelled') {
        actions += `<button class="btn btn-danger btn-sm" data-cancel="${pr.id}">Cancella${penalty > 0 && (pr.status === 'confirmed' || pr.status === 'paid') && pr.payment_method !== 'cash' ? ` (−€${penalty})` : ''}</button>`;
      }
      if (isAdmin && pr.payment_method === 'satispay' && (pr.status === 'awaiting_payment' || pr.status === 'pending') && !pr.satispay_verified) {
        actions += `<button class="btn btn-success btn-sm" data-verify-satispay="${pr.id}">✓ Verifica Satispay</button>`;
        actions += `<button class="btn btn-outline btn-sm" data-copy-link="${pr.id}">📋 Copia link</button>`;
      }
      if (isAdmin && pr.payment_method === 'cash' && (pr.status === 'awaiting_payment' || pr.status === 'pending')) {
        actions += `<button class="btn btn-success btn-sm" data-confirm-cash="${pr.id}">✓ Conferma contanti</button>`;
      }
      if (pr.payment_method === 'satispay' && (pr.status === 'awaiting_payment' || pr.status === 'pending') && !isAdmin) {
        actions += `<button class="btn btn-outline btn-sm" data-show-satispay="${pr.id}">📱 Mostra QR / link</button>`;
      }

      return `
      <div class="booking-card">
        <div class="info">
          <h4>${pr.seat_id} · ${pr.user_nome || state.user.nome}</h4>
          <p>${pr.season_name ? pr.season_name + ' · ' : ''}${formatDate(pr.data_inizio)} → ${formatDate(pr.data_fine)} (${pr.giorni} gg)</p>
          ${pr.user_email ? `<p>${pr.user_email}${pr.user_telefono ? ' · ' + pr.user_telefono : ''}</p>` : ''}
          <p>ID: ${pr.id}</p>
          <span class="badge ${pr.package}">${pr.package}</span>
          <span class="badge ${pr.status}">${pr.status}</span>
          ${pr.payment_method ? `<span class="badge ${pr.payment_method}">${pr.payment_method}</span>` : ''}
        </div>
        <div class="actions">${actions}</div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msg = penalty > 0
          ? `Cancellare ${btn.dataset.cancel}? Potrebbe essere applicata una penale di € ${penalty}.`
          : `Cancellare ${btn.dataset.cancel}?`;
        if (!confirm(msg)) return;
        try {
          const res = await api(`/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST', body: '{}' });
          toast(res.message || 'Prenotazione cancellata');
          renderBookingsList(containerId, all);
          loadSeats();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    container.querySelectorAll('[data-verify-satispay]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Verificare pagamento Satispay per ${btn.dataset.verifySatispay}?`)) return;
        try {
          const res = await api(`/bookings/${btn.dataset.verifySatispay}/verify-satispay`, { method: 'POST', body: '{}' });
          toast(res.message || 'Verificato');
          renderBookingsList(containerId, all);
          loadSeats();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    container.querySelectorAll('[data-confirm-cash]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Confermare pagamento contanti per ${btn.dataset.confirmCash}?`)) return;
        try {
          const res = await api(`/bookings/${btn.dataset.confirmCash}/confirm-cash`, { method: 'POST', body: '{}' });
          toast(res.message || 'Confermato');
          renderBookingsList(containerId, all);
          loadSeats();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    container.querySelectorAll('[data-copy-link]').forEach(btn => {
      btn.addEventListener('click', () => {
        const link = `${window.location.origin}/?satispay=${btn.dataset.copyLink}`;
        navigator.clipboard.writeText(link).then(() => toast('Link copiato')).catch(() => prompt('Copia:', link));
      });
    });

    container.querySelectorAll('[data-show-satispay]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const booking = bookings.find(b => b.id === btn.dataset.showSatispay);
        if (booking) {
          showSatispayModal(booking, {
            qrUrl: state.settings.satispayQrUrl,
            note: state.settings.satispayNote
          });
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
  }
}

// ---- Admin settings ----
function fillSettingsForm() {
  const s = state.settings || {};
  document.getElementById('cfg-beach-name').value = s.beachName || '';
  document.getElementById('cfg-banner-enabled').checked = !!s.bannerEnabled;
  document.getElementById('cfg-banner-text').value = s.bannerText || '';
  document.getElementById('cfg-banner-bg').value = s.bannerBg || '#0a7ea4';
  document.getElementById('cfg-banner-color').value = s.bannerColor || '#ffffff';
  document.getElementById('cfg-penalty').value = s.cancellationPenalty ?? 15;
  const rnEn = document.getElementById('cfg-refund-notice-enabled');
  const rnTx = document.getElementById('cfg-refund-notice-text');
  if (rnEn) rnEn.checked = s.refundNoticeEnabled !== false;
  if (rnTx) rnTx.value = s.refundNoticeText || 'Per cancellazioni prenotazioni con pagamento Carta di credito e Satispay il rimborso sarà riaccreditato con una penale di € {penale}.';
  document.getElementById('cfg-pay-stripe').checked = s.paymentStripe !== false;
  document.getElementById('cfg-pay-satispay').checked = !!s.paymentSatispay;
  document.getElementById('cfg-pay-cash').checked = !!s.paymentCash;
  document.getElementById('cfg-satispay-note').value = s.satispayNote || '';
  const prev = document.getElementById('satispay-qr-preview');
  if (s.satispayQrUrl) {
    prev.innerHTML = `<img src="${s.satispayQrUrl}" alt="QR" style="max-width:120px;border-radius:8px;border:1px solid var(--border)">`;
  } else {
    prev.innerHTML = '<span class="muted">Nessun QR caricato</span>';
  }
}

async function saveSettings() {
  try {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        beachName: document.getElementById('cfg-beach-name').value.trim(),
        bannerEnabled: document.getElementById('cfg-banner-enabled').checked,
        bannerText: document.getElementById('cfg-banner-text').value,
        bannerBg: document.getElementById('cfg-banner-bg').value,
        bannerColor: document.getElementById('cfg-banner-color').value,
        cancellationPenalty: parseFloat(document.getElementById('cfg-penalty').value) || 0,
        refundNoticeEnabled: document.getElementById('cfg-refund-notice-enabled')?.checked !== false,
        refundNoticeText: document.getElementById('cfg-refund-notice-text')?.value || '',
        paymentStripe: document.getElementById('cfg-pay-stripe').checked,
        paymentSatispay: document.getElementById('cfg-pay-satispay').checked,
        paymentCash: document.getElementById('cfg-pay-cash').checked,
        satispayNote: document.getElementById('cfg-satispay-note').value
      })
    });
    await loadSettings();
    toast('Impostazioni salvate');
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadSatispayQr() {
  const fileInput = document.getElementById('cfg-satispay-qr-file');
  if (!fileInput.files || !fileInput.files[0]) {
    toast('Seleziona un file immagine', 'error');
    return;
  }
  const fd = new FormData();
  fd.append('qr', fileInput.files[0]);
  try {
    const res = await fetch(API + '/settings/satispay-qr', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload fallito');
    await loadSettings();
    fillSettingsForm();
    toast('QR Satispay caricato');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Planimetria spiaggia ----
function updatePublicPlanimetry() {
  const wrap = document.getElementById('public-planimetry');
  const img = document.getElementById('public-planimetry-img');
  const url = state.settings?.beachMapUrl;
  if (!wrap || !img) return;
  if (url) {
    img.src = url;
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
    img.removeAttribute('src');
  }
}

function updateBeachMapPreview() {

  const url = state.settings?.beachMapUrl;
  const preview = document.getElementById('beach-map-preview');
  const empty = document.getElementById('beach-map-empty');
  const btnView = document.getElementById('btn-view-beach-map');
  const btnRemove = document.getElementById('btn-remove-beach-map');
  if (!preview) return;
  if (url) {
    preview.classList.add('has-image');
    preview.innerHTML = `<img src="${url}" alt="Planimetria" id="beach-map-thumb">`;
    if (empty) empty.style.display = 'none';
    if (btnView) btnView.style.display = '';
    if (btnRemove) btnRemove.style.display = '';
    const thumb = document.getElementById('beach-map-thumb');
    if (thumb) {
      thumb.addEventListener('click', showBeachMapModal);
    }
  } else {
    preview.classList.remove('has-image');
    preview.innerHTML = '<span class="muted" id="beach-map-empty">Nessuna planimetria caricata</span>';
    if (btnView) btnView.style.display = 'none';
    if (btnRemove) btnRemove.style.display = 'none';
  }
}

function showBeachMapModal() {
  const url = state.settings?.beachMapUrl;
  if (!url) {
    toast('Nessuna planimetria caricata', 'error');
    return;
  }
  const modal = document.getElementById('beach-map-modal');
  const img = document.getElementById('beach-map-modal-img');
  if (img) img.src = url;
  if (modal) modal.style.display = 'flex';
}

function hideBeachMapModal() {
  const modal = document.getElementById('beach-map-modal');
  if (modal) modal.style.display = 'none';
}

async function uploadBeachMap() {
  const fileInput = document.getElementById('cfg-beach-map-file');
  if (!fileInput.files || !fileInput.files[0]) {
    toast('Seleziona un file immagine', 'error');
    return;
  }
  const fd = new FormData();
  fd.append('map', fileInput.files[0]);
  try {
    const res = await fetch(API + '/settings/beach-map', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload fallito');
    await loadSettings();
    updateBeachMapPreview();
    document.getElementById('btn-upload-beach-map').style.display = 'none';
    document.getElementById('beach-map-filename').textContent = '';
    fileInput.value = '';
    toast('Planimetria caricata');
  } catch (e) { toast(e.message, 'error'); }
}

async function removeBeachMap() {
  if (!confirm('Eliminare la planimetria?')) return;
  try {
    await api('/settings/beach-map', { method: 'DELETE' });
    await loadSettings();
    updateBeachMapPreview();
    toast('Planimetria eliminata');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Admin rows ----
async function loadRowsAdmin() {
  try {
    const { rows } = await api('/rows');
    state.rows = rows;
    const list = document.getElementById('rows-admin-list');
    if (!rows.length) {
      list.innerHTML = '<p class="muted">Nessuna file</p>';
      return;
    }
    list.innerHTML = rows.map(r => {
      const start = r.startNumber || 1;
      const end = start + r.seats - 1;
      return `
      <div class="season-card">
        <div class="season-info">
          <strong>${r.name}</strong>
          <span>${r.seats} ombrelloni · numerazione ${start}–${end} · ID file ${r.id}</span>
        </div>
        <div class="actions" style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center">
          <input class="row-edit-input" data-row-name="${r.id}" value="${r.name}" title="Nome">
          <input class="row-edit-input" type="number" min="1" max="50" data-row-seats="${r.id}" value="${r.seats}" title="N° posti" style="max-width:70px">
          <input class="row-edit-input" type="number" min="1" max="999" data-row-start="${r.id}" value="${start}" title="Numerazione da (primo ombrellone)" style="max-width:70px">
          <button class="btn btn-sm btn-outline" data-save-row="${r.id}">Salva</button>
          <button class="btn btn-sm btn-danger" data-del-row="${r.id}">Elimina</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-save-row]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.saveRow;
        const name = list.querySelector(`[data-row-name="${id}"]`).value.trim();
        const seats = parseInt(list.querySelector(`[data-row-seats="${id}"]`).value) || 12;
        const startNumber = Math.max(1, parseInt(list.querySelector(`[data-row-start="${id}"]`).value) || 1);
        try {
          await api(`/rows/${id}`, { method: 'PUT', body: JSON.stringify({ name, seats, startNumber }) });
          toast('File aggiornata – numerazione applicata');
          await loadRowsAdmin();
          await loadPrices();
          renderPriceTable();
          await loadSeats();
          if (document.getElementById('admin-map')) await loadSeatsAdmin();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    list.querySelectorAll('[data-del-row]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eliminare questa file e tutti i suoi posti?')) return;
        try {
          await api(`/rows/${btn.dataset.delRow}`, { method: 'DELETE' });
          toast('File eliminata');
          await loadRowsAdmin();
          await loadPrices();
          renderPriceTable();
          await loadSeats();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

async function addRow() {
  const name = document.getElementById('new-row-name').value.trim();
  const seats = parseInt(document.getElementById('new-row-seats').value) || 12;
  const startNumber = Math.max(1, parseInt(document.getElementById('new-row-start')?.value) || 1);
  if (!name) { toast('Inserisci un nome', 'error'); return; }
  try {
    await api('/rows', { method: 'POST', body: JSON.stringify({ name, seats, startNumber }) });
    toast('File creata');
    document.getElementById('new-row-name').value = '';
    if (document.getElementById('new-row-start')) document.getElementById('new-row-start').value = '1';
    await loadRowsAdmin();
    await loadPrices();
    renderPriceTable();
    await loadSeats();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Admin seasons ----
async function loadSeasonsAdmin() {
  try {
    const { seasons } = await api('/seasons?all=1');
    const list = document.getElementById('seasons-admin-list');
    if (!seasons.length) {
      list.innerHTML = '<p class="muted">Nessuna stagione</p>';
      return;
    }
    list.innerHTML = seasons.map(s => `
      <div class="season-card ${s.active ? '' : 'inactive'}">
        <div class="season-info">
          <strong>${s.name}</strong>
          <span>${formatDate(s.start)} → ${formatDate(s.end)}</span>
          <span class="badge ${s.active ? 'active-badge' : 'inactive-badge'}">${s.active ? 'Attiva' : 'Disattiva'}</span>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-outline" data-toggle-season="${s.id}">${s.active ? 'Disattiva' : 'Attiva'}</button>
          <button class="btn btn-sm btn-danger" data-del-season="${s.id}">Elimina</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('[data-toggle-season]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const s = seasons.find(x => x.id === btn.dataset.toggleSeason);
        try {
          await api(`/seasons/${s.id}`, { method: 'PUT', body: JSON.stringify({ active: !s.active }) });
          toast(s.active ? 'Stagione disattivata' : 'Stagione attivata');
          await loadSeasonsAdmin();
          await loadSeasons();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    list.querySelectorAll('[data-del-season]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eliminare questa stagione?')) return;
        try {
          await api(`/seasons/${btn.dataset.delSeason}`, { method: 'DELETE' });
          toast('Stagione eliminata');
          await loadSeasonsAdmin();
          await loadSeasons();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

async function addSeason() {
  const name = document.getElementById('new-season-name').value.trim();
  const start = document.getElementById('new-season-start').value;
  const end = document.getElementById('new-season-end').value;
  if (!name || !start || !end) { toast('Compila tutti i campi', 'error'); return; }
  try {
    await api('/seasons', { method: 'POST', body: JSON.stringify({ name, start, end, active: true }) });
    toast('Stagione creata');
    document.getElementById('new-season-name').value = '';
    await loadSeasonsAdmin();
    await loadSeasons();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Prices ----
async function loadPrices() {
  const { prices } = await api('/prices');
  state.prezzi = prices;
}

function renderPriceTable() {
  const tbody = document.querySelector('#price-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = [...(state.rows || [])].sort((a, b) => (a.order || a.id) - (b.order || b.id));
  const filaIds = rows.length ? rows.map(r => r.id) : Object.keys(state.prezzi).map(Number).sort((a, b) => a - b);
  for (const f of filaIds) {
    const p = state.prezzi[f] || { giornaliera: 40, scontoSettimanale: 10, scontoQuindicinale: 15, scontoMensile: 20 };
    const name = getRowName(f);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td><input type="number" min="0" step="0.5" data-fila="${f}" data-field="giornaliera" value="${p.giornaliera}"></td>
      <td><input type="number" min="0" max="50" data-fila="${f}" data-field="scontoSettimanale" value="${p.scontoSettimanale}"></td>
      <td><input type="number" min="0" max="50" data-fila="${f}" data-field="scontoQuindicinale" value="${p.scontoQuindicinale}"></td>
      <td><input type="number" min="0" max="50" data-fila="${f}" data-field="scontoMensile" value="${p.scontoMensile}"></td>
    `;
    tbody.appendChild(tr);
  }
}

async function salvaPrezzi() {
  const prices = {};
  document.querySelectorAll('#price-table input').forEach(input => {
    if (!prices[input.dataset.fila]) prices[input.dataset.fila] = {};
    prices[input.dataset.fila][input.dataset.field] = parseFloat(input.value) || 0;
  });
  try {
    await api('/prices', { method: 'PUT', body: JSON.stringify({ prices }) });
    state.prezzi = prices;
    toast('Prezzi salvati');
    updateRiepilogo();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- CSV Export ----
async function exportCsv(all = false) {
  if (!state.token) {
    toast('Accedi per esportare', 'error');
    return;
  }
  try {
    const q = all ? '?all=1' : '';
    const res = await fetch(API + '/bookings/export' + q, {
      headers: { Authorization: 'Bearer ' + state.token }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Export fallito');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = all ? 'prenotazioni-tutte.csv' : 'mie-prenotazioni.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('CSV scaricato');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- Navigation ----
function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${viewId}`).classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-view="${viewId}"]`);
  if (btn) btn.classList.add('active');

  if (viewId === 'mie-prenotazioni') renderBookingsList('lista-prenotazioni');
  if (viewId === 'calendario') loadCalendar();
  if (viewId === 'admin') {
    fillSettingsForm();
    updateBeachMapPreview();
    loadRowsAdmin();
    loadSeasonsAdmin();
    renderPriceTable();
    loadSeatsAdmin();
    renderBookingsList('admin-lista-prenotazioni', true);
  }
  if (viewId === 'prenota') loadSeats();
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin-${tab}`).classList.add('active');
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  const bookingId = params.get('booking');
  const sessionId = params.get('session_id');
  const satispayId = params.get('satispay');

  if (satispayId) {
    window.history.replaceState({}, '', window.location.pathname);
    try {
      const { bookings } = await api('/bookings');
      const booking = bookings.find(b => b.id === satispayId);
      if (booking) {
        showSatispayModal(booking, {
          qrUrl: state.settings.satispayQrUrl,
          note: state.settings.satispayNote
        });
      } else {
        toast('Prenotazione non trovata o non tua', 'error');
      }
    } catch {
      toast('Accedi per visualizzare il pagamento Satispay', 'error');
      showAuthModal('login');
    }
    return;
  }

  if (!payment) return;
  window.history.replaceState({}, '', window.location.pathname);

  if (payment === 'success' && bookingId) {
    if (sessionId && state.token) {
      try { await api(`/payments/verify-session?session_id=${sessionId}&booking=${bookingId}`); } catch {}
    }
    toast(`Pagamento riuscito! Prenotazione ${bookingId} confermata`);
    switchView('mie-prenotazioni');
  } else if (payment === 'cancelled') {
    toast('Pagamento annullato', 'error');
  }
}

// ---- Init ----
async function init() {
  updateAuthUI();

  try {
    const cfg = await api('/payments/config');
    state.paymentMode = cfg.mode;
  } catch {}

  try { await loadSettings(); } catch {}
  try { await loadPrices(); } catch {}
  try {
    const { rows } = await api('/rows');
    state.rows = rows;
  } catch {}
  try { await loadSeasons(); } catch (e) { console.warn(e); }
  await loadSeats();
  onPackageChange();
  updateRiepilogo();
  await handlePaymentReturn();

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
  });
  document.querySelectorAll('input[name="package"]').forEach(r => {
    r.addEventListener('change', onPackageChange);
  });
  document.querySelectorAll('input[name="payment"]').forEach(r => {
    r.addEventListener('change', updateRiepilogo);
  });

  document.getElementById('season-select').addEventListener('change', e => {
    state.selectedSeasonId = e.target.value;
    updateSeasonRangeLabel();
    applySeasonDateLimits();
    state.selectedSeat = null;
    updateRiepilogo();
    loadSeats();
  });

  document.getElementById('cal-season').addEventListener('change', loadCalendar);

  document.getElementById('data-inizio').addEventListener('change', () => {
    updateDateFine();
    state.selectedSeat = null;
    updateRiepilogo();
    loadSeats();
  });
  document.getElementById('num-giorni').addEventListener('input', () => {
    let val = parseInt(document.getElementById('num-giorni').value) || 1;
    if (val > CONFIG.maxGiorniGiornaliera) document.getElementById('num-giorni').value = CONFIG.maxGiorniGiornaliera;
    updateDateFine();
    state.selectedSeat = null;
    updateRiepilogo();
    loadSeats();
  });

  document.getElementById('btn-prenota').addEventListener('click', creaPrenotazioneEPaga);
  document.getElementById('btn-salva-prezzi').addEventListener('click', salvaPrezzi);
  document.getElementById('btn-add-season').addEventListener('click', addSeason);
  document.getElementById('btn-add-row').addEventListener('click', addRow);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-upload-qr').addEventListener('click', uploadSatispayQr);

  // Planimetria
  const btnPickMap = document.getElementById('btn-pick-beach-map');
  const fileMap = document.getElementById('cfg-beach-map-file');
  const btnUploadMap = document.getElementById('btn-upload-beach-map');
  if (btnPickMap && fileMap) {
    btnPickMap.addEventListener('click', () => fileMap.click());
    fileMap.addEventListener('change', () => {
      const f = fileMap.files?.[0];
      const nameEl = document.getElementById('beach-map-filename');
      if (f) {
        if (nameEl) nameEl.textContent = f.name;
        if (btnUploadMap) btnUploadMap.style.display = '';
      } else {
        if (nameEl) nameEl.textContent = '';
        if (btnUploadMap) btnUploadMap.style.display = 'none';
      }
    });
  }
  if (btnUploadMap) btnUploadMap.addEventListener('click', uploadBeachMap);
  const btnViewMap = document.getElementById('btn-view-beach-map');
  if (btnViewMap) btnViewMap.addEventListener('click', showBeachMapModal);
  const btnRemoveMap = document.getElementById('btn-remove-beach-map');
  if (btnRemoveMap) btnRemoveMap.addEventListener('click', removeBeachMap);
  const beachMapClose = document.getElementById('beach-map-close');
  const beachMapBackdrop = document.getElementById('beach-map-backdrop');
  if (beachMapClose) beachMapClose.addEventListener('click', hideBeachMapModal);
  if (beachMapBackdrop) beachMapBackdrop.addEventListener('click', hideBeachMapModal);

  const btnMyCsv = document.getElementById('btn-export-my-csv');
  if (btnMyCsv) btnMyCsv.addEventListener('click', () => exportCsv(false));
  const btnAllCsv = document.getElementById('btn-export-all-csv');
  if (btnAllCsv) btnAllCsv.addEventListener('click', () => exportCsv(true));

  document.getElementById('btn-show-login').addEventListener('click', () => showAuthModal('login'));
  document.getElementById('btn-show-register').addEventListener('click', () => showAuthModal('register'));
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('auth-close').addEventListener('click', hideAuthModal);
  document.getElementById('auth-backdrop').addEventListener('click', hideAuthModal);
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('btn-register').addEventListener('click', doRegister);
  document.getElementById('switch-to-register').addEventListener('click', e => { e.preventDefault(); showAuthModal('register'); });
  document.getElementById('switch-to-login').addEventListener('click', e => { e.preventDefault(); showAuthModal('login'); });
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

  document.getElementById('satispay-close').addEventListener('click', hideSatispayModal);
  document.getElementById('satispay-backdrop').addEventListener('click', hideSatispayModal);
  document.getElementById('btn-copy-satispay-link').addEventListener('click', copySatispayLink);
  document.getElementById('btn-satispay-done').addEventListener('click', () => {
    hideSatispayModal();
    switchView('mie-prenotazioni');
  });
  document.getElementById('promo-close').addEventListener('click', () => {
    document.getElementById('promo-banner').style.display = 'none';
  });

  const btnPubPlan = document.getElementById('btn-public-planimetry');
  if (btnPubPlan) btnPubPlan.addEventListener('click', showBeachMapModal);
  const pubPlanImg = document.getElementById('public-planimetry-img');
  if (pubPlanImg) pubPlanImg.addEventListener('click', showBeachMapModal);
}

document.addEventListener('DOMContentLoaded', init);
