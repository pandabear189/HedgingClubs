/* ============================================================================
   ClubHedge — play-money prediction market for club recruiting season.
   Vanilla JS, no build step, no network. State lives in localStorage and is
   portable as a single JSON file.

   ── DATA MODEL ────────────────���────────────────────────────────────────────
   Pool {
     id, name, createdAt, schemaVersion,
     settings: {
       startingChips,   // seeded to every new bettor
       payout,          // decimal odds, e.g. 1.9 -> a winning 100 returns 190
       cancelFeePct,    // fraction of stake burned when a bet is cancelled/edited
       locked           // true = no new bets, pool is frozen
     },
     clubs:      [{ id, name, note }],
     candidates: [{ id, name, year, school }],
     bettors:    [{ id, name }],
     markets:    [{ id, candidateId, clubId,
                    interview:  { result: 'pending'|'yes'|'no' },
                    acceptance: { result: 'pending'|'yes'|'no' } }],
     bets:       [{ id, marketId, bettorId,
                    leg:  'interview'|'acceptance',
                    side: 'yes'|'no',
                    stake, payout,                  // payout = odds at time of placement
                    status: 'open'|'won'|'lost'|'cancelled',
                    createdAt, settledAt }],
     ledger:     [{ id, ts, bettorId, type, amount, betId, note }]
   }

   The LEDGER is the source of truth for chips. A bettor's balance is always
   sum(ledger.amount) for that bettor — never a stored, drifting number.
     seed    +startingChips   bettor created (or starting stack changed)
     stake   -stake           chips locked into a bet
     refund  +stake-fee       bet cancelled before settlement
     fee     -fee             hedging friction on a cancel/edit
     payout  +stake*odds      winning bet settled (includes the stake back)
     loss     0               losing bet settled; zero-value, kept for the feed

   Markets are created lazily: a candidate x club pair only becomes a row in
   `markets` once someone bets on it or the house sets a result for it.
   The two legs (interview / acceptance) are independent markets: a "no" on
   interview does NOT auto-settle acceptance. The house settles each leg.
   Setting a leg's result settles every open bet on it; setting it back to
   "pending" reverses those settlements (for fat-finger recovery).
   ========================================================================== */

'use strict';

const KEY = 'clubhedge.pool.v1';
const KEY_ME = 'clubhedge.me.v1';
const SCHEMA = 1;

/* ── tiny helpers ─────────────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => Number(x || 0).toLocaleString('en-US');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

let toastTimer;
function toast(msg, bad) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ── state ────────────────────────────────────────────────────────────────── */
let pool = null;                       // the Pool object, or null if none loaded
let view = 'board';                    // active tab
let me = localStorage.getItem(KEY_ME); // bettorId of "who am I" (convenience only)
const filters = { club: '', candidate: '', q: '', hideSettled: false };

function save() {
  if (pool) localStorage.setItem(KEY, JSON.stringify(pool));
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) pool = migrate(JSON.parse(raw));
  } catch (e) {
    console.error('could not read saved pool', e);
  }
}

/** Tolerate older/partial payloads so an import never hard-fails on a missing key. */
function migrate(p) {
  if (!p || typeof p !== 'object') throw new Error('not a pool');
  p.schemaVersion = SCHEMA;
  p.settings = Object.assign(
    { startingChips: 1000, payout: 1.9, cancelFeePct: 0.05, locked: false },
    p.settings || {}
  );
  for (const k of ['clubs', 'candidates', 'bettors', 'markets', 'bets', 'ledger']) {
    if (!Array.isArray(p[k])) p[k] = [];
  }
  for (const m of p.markets) {
    m.interview = m.interview || { result: 'pending' };
    m.acceptance = m.acceptance || { result: 'pending' };
  }
  return p;
}

function newPool(name) {
  return {
    id: uid('pool'),
    name: name || 'Untitled Pool',
    createdAt: Date.now(),
    schemaVersion: SCHEMA,
    settings: { startingChips: 1000, payout: 1.9, cancelFeePct: 0.05, locked: false },
    clubs: [], candidates: [], bettors: [], markets: [], bets: [], ledger: []
  };
}

/* ── derived values ───────────────────────────────────────────────────────── */
const byId = (arr, id) => arr.find((x) => x.id === id);
const clubName = (id) => byId(pool.clubs, id)?.name ?? '—';
const candName = (id) => byId(pool.candidates, id)?.name ?? '—';
const bettorName = (id) => byId(pool.bettors, id)?.name ?? '—';

function entry(bettorId, type, amount, betId, note) {
  pool.ledger.push({
    id: uid('led'), ts: Date.now(), bettorId, type,
    amount: Math.round(amount), betId: betId || null, note: note || ''
  });
}

/** Liquid chips: everything in the ledger. Staked chips are already deducted. */
function balance(bettorId) {
  let sum = 0;
  for (const e of pool.ledger) if (e.bettorId === bettorId) sum += e.amount;
  return Math.round(sum);
}

/** Chips currently locked in open bets. */
function atRisk(bettorId) {
  let sum = 0;
  for (const b of pool.bets) if (b.bettorId === bettorId && b.status === 'open') sum += b.stake;
  return sum;
}

/** Everything seeded to a bettor, so P&L = equity - seeded. */
function seeded(bettorId) {
  let sum = 0;
  for (const e of pool.ledger) if (e.bettorId === bettorId && e.type === 'seed') sum += e.amount;
  return sum;
}

function stats(bettorId) {
  const chips = balance(bettorId);
  const risk = atRisk(bettorId);
  const base = seeded(bettorId);
  const bets = pool.bets.filter((b) => b.bettorId === bettorId);
  const won = bets.filter((b) => b.status === 'won').length;
  const lost = bets.filter((b) => b.status === 'lost').length;
  return {
    chips, risk, equity: chips + risk, pnl: chips + risk - base,
    settled: won + lost, won, lost,
    open: bets.filter((b) => b.status === 'open').length
  };
}

/** Find (or lazily create) the market for a candidate x club pair. */
function getMarket(candidateId, clubId, create) {
  let m = pool.markets.find((x) => x.candidateId === candidateId && x.clubId === clubId);
  if (!m && create) {
    m = {
      id: uid('mkt'), candidateId, clubId,
      interview: { result: 'pending' }, acceptance: { result: 'pending' }
    };
    pool.markets.push(m);
  }
  return m;
}

/** Aggregate open/settled stake per side for one leg of one market. */
function book(marketId, leg) {
  const out = { yes: 0, no: 0, count: 0 };
  for (const b of pool.bets) {
    if (b.marketId !== marketId || b.leg !== leg || b.status === 'cancelled') continue;
    out[b.side] += b.stake;
    out.count++;
  }
  return out;
}

/* ── actions ──────────────────────────────────────────────────────────────── */
function placeBet(marketId, leg, bettorId, side, stake) {
  const m = byId(pool.markets, marketId);
  if (!m) return toast('market vanished', true);
  if (pool.settings.locked) return toast('pool is locked', true);
  if (m[leg].result !== 'pending') return toast('that leg is already settled', true);
  stake = Math.floor(Number(stake));
  if (!(stake > 0)) return toast('stake must be positive', true);
  if (stake > balance(bettorId)) return toast('not enough chips', true);

  const bet = {
    id: uid('bet'), marketId, bettorId, leg, side,
    stake, payout: Number(pool.settings.payout),
    status: 'open', createdAt: Date.now(), settledAt: null
  };
  pool.bets.push(bet);
  entry(bettorId, 'stake', -stake, bet.id,
    `${side.toUpperCase()} · ${leg} · ${candName(m.candidateId)} @ ${clubName(m.clubId)}`);
  save();
  toast(`${n(stake)} on ${side.toUpperCase()}. Good luck.`);
}

/** Cancel refunds the stake minus the hedging fee. Used by edit as well. */
function cancelBet(betId, silent) {
  const b = byId(pool.bets, betId);
  if (!b || b.status !== 'open') return;
  const fee = Math.round(b.stake * pool.settings.cancelFeePct);
  b.status = 'cancelled';
  b.settledAt = Date.now();
  entry(b.bettorId, 'refund', b.stake, b.id, 'cancelled bet');
  if (fee > 0) entry(b.bettorId, 'fee', -fee, b.id, 'cancellation fee');
  save();
  if (!silent) toast(fee > 0 ? `Cancelled. ${n(fee)} chips kept by the house.` : 'Cancelled.');
}

/**
 * Set a leg's result. 'yes'/'no' settles every open bet on it;
 * 'pending' reverses a prior settlement and reopens those bets.
 */
function setResult(marketId, leg, result) {
  const m = byId(pool.markets, marketId);
  if (!m) return;
  const prev = m[leg].result;
  if (prev === result) return;

  if (result === 'pending') {
    // Reverse: drop settlement ledger entries for this leg, reopen the bets.
    const ids = new Set(pool.bets
      .filter((b) => b.marketId === marketId && b.leg === leg && (b.status === 'won' || b.status === 'lost'))
      .map((b) => b.id));
    pool.ledger = pool.ledger.filter(
      (e) => !(ids.has(e.betId) && (e.type === 'payout' || e.type === 'loss')));
    for (const b of pool.bets) {
      if (ids.has(b.id)) { b.status = 'open'; b.settledAt = null; }
    }
    m[leg].result = 'pending';
    save();
    return toast('Result cleared. Bets are live again.');
  }

  m[leg].result = result;
  let paid = 0, count = 0;
  for (const b of pool.bets) {
    if (b.marketId !== marketId || b.leg !== leg || b.status !== 'open') continue;
    count++;
    b.settledAt = Date.now();
    const label = `${leg} ${result.toUpperCase()} · ${candName(m.candidateId)} @ ${clubName(m.clubId)}`;
    if (b.side === result) {
      b.status = 'won';
      const ret = Math.round(b.stake * b.payout);
      paid += ret;
      entry(b.bettorId, 'payout', ret, b.id, `won ${label}`);
    } else {
      b.status = 'lost';
      entry(b.bettorId, 'loss', 0, b.id, `lost ${label}`);
    }
  }
  save();
  toast(count ? `Settled ${count} bet${count > 1 ? 's' : ''}, ${n(paid)} chips paid out.`
              : 'Result recorded. Nobody had a position.');
}

function addBettor(name) {
  const b = { id: uid('btr'), name };
  pool.bettors.push(b);
  entry(b.id, 'seed', pool.settings.startingChips, null, 'starting stack');
  save();
  return b;
}

/* ── modal ────────────────────────────────────────────────────────────────── */
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
}

function openSlip(candidateId, clubId, leg, side, editBetId) {
  if (!pool.bettors.length) return toast('add a bettor first (Setup)', true);
  const m = getMarket(candidateId, clubId, true);
  const edit = editBetId ? byId(pool.bets, editBetId) : null;
  const bettorId = edit ? edit.bettorId : (me && byId(pool.bettors, me) ? me : pool.bettors[0].id);

  const odds = pool.settings.payout;
  const opts = pool.bettors.map((b) =>
    `<option value="${b.id}" ${b.id === bettorId ? 'selected' : ''}>${esc(b.name)} — ${n(balance(b.id))}</option>`).join('');

  openModal(`
    <h3>${edit ? 'Edit bet' : 'Bet slip'}</h3>
    <div class="slip-market">${esc(candName(candidateId))}</div>
    <div class="slip-line">
      ${esc(clubName(clubId))} · ${leg} ·
      <b class="${side === 'yes' ? 'pos' : 'neg'}">${side.toUpperCase()}</b> @ ${odds}×
    </div>
    <div class="field" style="margin-bottom:12px">
      <label>Bettor</label>
      <select id="slipBettor" ${edit ? 'disabled' : ''}>${opts}</select>
    </div>
    <div class="field">
      <label>Stake</label>
      <input type="number" id="slipStake" min="1" step="1" value="${edit ? edit.stake : 100}" />
      <div class="quick">
        <button class="btn sm" data-quick="25">25</button>
        <button class="btn sm" data-quick="50">50</button>
        <button class="btn sm" data-quick="100">100</button>
        <button class="btn sm" data-quick="250">250</button>
        <button class="btn sm" data-quick="max">all in</button>
      </div>
    </div>
    <div class="calc"><span class="dim">to return</span><span id="slipReturn">—</span></div>
    ${edit ? `<div class="slip-line" style="margin:10px 0 0">Editing refunds the old stake minus a
       ${Math.round(pool.settings.cancelFeePct * 100)}% fee. Hedging isn't free.</div>` : ''}
    <div class="modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="slipGo">${edit ? 'Replace bet' : 'Place bet'}</button>
    </div>
  `);

  const stakeEl = $('#slipStake');
  const bettorEl = $('#slipBettor');
  const sync = () => {
    const s = Math.floor(Number(stakeEl.value) || 0);
    const bal = balance(bettorEl.value) + (edit ? edit.stake - Math.round(edit.stake * pool.settings.cancelFeePct) : 0);
    $('#slipReturn').innerHTML = s > 0
      ? `<b class="${s > bal ? 'neg' : 'pos'}">${n(Math.round(s * odds))}</b>
         <span class="dim">(+${n(Math.round(s * odds) - s)})</span>`
      : '—';
  };
  stakeEl.addEventListener('input', sync);
  bettorEl.addEventListener('change', sync);
  sync();
  setTimeout(() => stakeEl.select(), 30);

  document.querySelectorAll('#modalBody [data-quick]').forEach((q) => {
    q.addEventListener('click', () => {
      const bal = balance(bettorEl.value) +
        (edit ? edit.stake - Math.round(edit.stake * pool.settings.cancelFeePct) : 0);
      stakeEl.value = q.dataset.quick === 'max' ? bal : q.dataset.quick;
      sync();
    });
  });

  $('#slipGo').addEventListener('click', () => {
    const stake = Math.floor(Number(stakeEl.value) || 0);
    if (edit) cancelBet(edit.id, true);            // edit = cancel (with fee) + re-place
    placeBet(m.id, leg, bettorEl.value, side, stake);
    closeModal();
    render();
  });
}

/* ── views ────────────────────────────────────────────────────────────────── */

function viewBoard() {
  const { clubs, candidates } = pool;
  if (!clubs.length || !candidates.length) {
    return `<div class="empty">The board is empty. Add at least one club and one candidate in
      <b>Setup</b>, then the markets build themselves.</div>`;
  }

  const rows = [];
  for (const c of candidates) {
    for (const k of clubs) {
      if (filters.club && k.id !== filters.club) continue;
      if (filters.candidate && c.id !== filters.candidate) continue;
      const q = filters.q.toLowerCase();
      if (q && !(c.name + ' ' + k.name + ' ' + (c.school || '') + ' ' + (c.year || ''))
        .toLowerCase().includes(q)) continue;
      const m = getMarket(c.id, k.id, false);
      const settled = m && m.interview.result !== 'pending' && m.acceptance.result !== 'pending';
      if (filters.hideSettled && settled) continue;
      rows.push(marketCard(c, k, m));
    }
  }

  return `
    <div class="toolbar">
      <select id="fClub">
        <option value="">All clubs</option>
        ${clubs.map((k) => `<option value="${k.id}" ${filters.club === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
      <select id="fCand">
        <option value="">All candidates</option>
        ${candidates.map((c) => `<option value="${c.id}" ${filters.candidate === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <input type="text" id="fQ" placeholder="Search…" value="${esc(filters.q)}" />
      <button class="btn sm ${filters.hideSettled ? 'primary' : ''}" id="fSettled">Hide settled</button>
      <div class="spacer"></div>
      ${pool.bettors.length ? `<select id="whoAmI" title="Default bettor on the slip">
        ${pool.bettors.map((b) => `<option value="${b.id}" ${me === b.id ? 'selected' : ''}>Betting as ${esc(b.name)} — ${n(balance(b.id))}</option>`).join('')}
      </select>` : ''}
    </div>
    ${pool.settings.locked ? `<div class="empty" style="margin-bottom:14px">Pool is locked. No new
      positions — you're stuck with your opinions.</div>` : ''}
    ${rows.length ? rows.join('') : '<div class="empty">Nothing matches that filter.</div>'}
    ${openBetsTable()}
  `;
}

function marketCard(c, k, m) {
  const mkt = m || { id: null, interview: { result: 'pending' }, acceptance: { result: 'pending' } };
  return `
    <div class="market">
      <div class="market-head">
        <div class="market-who">
          <div class="name">${esc(c.name)}</div>
          <div class="meta">${[c.year, c.school].filter(Boolean).map(esc).join(' · ') || 'no details'}</div>
        </div>
        <div class="club">${esc(k.name)}</div>
      </div>
      <div class="legs">
        ${legBlock(c, k, mkt, 'interview', 'Interview')}
        ${legBlock(c, k, mkt, 'acceptance', 'Acceptance')}
      </div>
    </div>`;
}

function legBlock(c, k, m, leg, label) {
  const res = m[leg].result;
  const bk = m.id ? book(m.id, leg) : { yes: 0, no: 0, count: 0 };
  const total = bk.yes + bk.no;
  const done = res !== 'pending';
  const odds = pool.settings.payout;
  const lock = done || pool.settings.locked;

  return `
    <div class="leg">
      <div class="leg-head">
        <span class="leg-title">${label}</span>
        <span class="pill ${res}">${res === 'pending' ? 'pending…' : res}</span>
      </div>
      <div class="leg-actions">
        <button class="side-btn yes" data-bet="${c.id}|${k.id}|${leg}|yes" ${lock ? 'disabled' : ''}>Yes ${odds}×</button>
        <button class="side-btn no"  data-bet="${c.id}|${k.id}|${leg}|no"  ${lock ? 'disabled' : ''}>No ${odds}×</button>
      </div>
      ${total ? `<div class="vol">
          <i class="y" style="width:${(bk.yes / total) * 100}%"></i>
          <i class="n" style="width:${(bk.no / total) * 100}%"></i>
        </div>` : ''}
      <div class="leg-book">
        <span>yes <b>${n(bk.yes)}</b></span>
        <span>no <b>${n(bk.no)}</b></span>
        <span>${bk.count} bet${bk.count === 1 ? '' : 's'}</span>
      </div>
    </div>`;
}

function openBetsTable() {
  const open = pool.bets.filter((b) => b.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
  if (!open.length) return '';
  return `
    <div class="section" style="margin-top:30px">
      <div class="section-head">
        <h2>Open positions</h2>
        <span class="hint">${open.length} live · ${n(open.reduce((s, b) => s + b.stake, 0))} chips at risk</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Bettor</th><th>Market</th><th>Pick</th>
          <th class="num">Stake</th><th class="num">To return</th><th></th>
        </tr></thead>
        <tbody>${open.map((b) => {
          const m = byId(pool.markets, b.marketId);
          return `<tr>
            <td>${esc(bettorName(b.bettorId))}</td>
            <td>${esc(candName(m.candidateId))} <span class="dim">@ ${esc(clubName(m.clubId))}</span></td>
            <td><span class="mono dim">${b.leg}</span>
                <b class="${b.side === 'yes' ? 'pos' : 'neg'}">${b.side.toUpperCase()}</b></td>
            <td class="num">${n(b.stake)}</td>
            <td class="num">${n(Math.round(b.stake * b.payout))}</td>
            <td class="num" style="white-space:nowrap">
              <button class="btn sm" data-edit="${b.id}">Edit</button>
              <button class="btn sm danger" data-cancelbet="${b.id}">Pull</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
}

function viewHouse() {
  if (!pool.clubs.length || !pool.candidates.length) {
    return '<div class="empty">Nothing to rule on yet. Add clubs and candidates in Setup.</div>';
  }
  const rows = [];
  for (const c of pool.candidates) {
    for (const k of pool.clubs) {
      if (filters.club && k.id !== filters.club) continue;
      if (filters.candidate && c.id !== filters.candidate) continue;
      const m = getMarket(c.id, k.id, false);
      const id = m ? m.id : `new:${c.id}:${k.id}`;
      const bets = m ? pool.bets.filter((b) => b.marketId === m.id && b.status !== 'cancelled').length : 0;
      rows.push(`<tr>
        <td>${esc(c.name)} <span class="dim">@ ${esc(clubName(k.id))}</span></td>
        <td>${resultPicker(id, 'interview', m ? m.interview.result : 'pending')}</td>
        <td>${resultPicker(id, 'acceptance', m ? m.acceptance.result : 'pending')}</td>
        <td class="num dim">${bets || '—'}</td>
      </tr>`);
    }
  }
  return `
    <p class="blurb">The house marks reality. Setting a result instantly settles every open bet on
      that leg; setting it back to <i>pending</i> unwinds the settlement if you misfired.
      Interview and acceptance settle independently.</p>
    <div class="toolbar">
      <select id="fClub"><option value="">All clubs</option>
        ${pool.clubs.map((k) => `<option value="${k.id}" ${filters.club === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
      <select id="fCand"><option value="">All candidates</option>
        ${pool.candidates.map((c) => `<option value="${c.id}" ${filters.candidate === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Market</th><th>Interview</th><th>Acceptance</th><th class="num">Bets</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

function resultPicker(marketRef, leg, value) {
  return ['pending', 'yes', 'no'].map((v) =>
    `<button class="btn sm ${v === value ? 'primary' : 'ghost'}"
       data-result="${marketRef}|${leg}|${v}">${v === 'pending' ? '?' : v}</button>`).join(' ');
}

function viewLeaderboard() {
  if (!pool.bettors.length) return '<div class="empty">No bettors yet. Add a few in Setup.</div>';
  const rows = pool.bettors.map((b) => ({ b, s: stats(b.id) }))
    .sort((x, y) => y.s.equity - x.s.equity);
  const top = Math.max(...rows.map((r) => r.s.equity), 1);

  const feed = pool.ledger.slice().sort((a, b) => b.ts - a.ts).slice(0, 40);

  return `
    <div class="section">
      <div class="section-head">
        <h2>Standings</h2>
        <span class="hint">equity = chips in hand + chips at risk</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th></th><th>Bettor</th><th class="num">Chips</th><th class="num">At risk</th>
          <th class="num">Equity</th><th class="num">P&amp;L</th><th class="num">W–L</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
          <td class="rank">${String(i + 1).padStart(2, '0')}</td>
          <td><b>${esc(r.b.name)}</b></td>
          <td class="num">${n(r.s.chips)}</td>
          <td class="num dim">${r.s.risk ? n(r.s.risk) : '—'}</td>
          <td class="num">${n(r.s.equity)}</td>
          <td class="num ${r.s.pnl > 0 ? 'pos' : r.s.pnl < 0 ? 'neg' : 'dim'}">
            ${r.s.pnl > 0 ? '+' : ''}${n(r.s.pnl)}</td>
          <td class="num dim">${r.s.won}–${r.s.lost}</td>
          <td style="width:28%"><div class="bar"><i style="width:${clamp((r.s.equity / top) * 100, 0, 100)}%"></i></div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>Activity</h2>
        <span class="hint">most recent 40 movements</span>
      </div>
      ${feed.length ? `<div class="feed">${feed.map((e) => `
        <div class="feed-item">
          <span class="t">${fmtTime(e.ts)}</span>
          <span><b>${esc(bettorName(e.bettorId))}</b>
            <span class="dim">${esc(e.note || e.type)}</span></span>
          <span class="amt ${e.amount > 0 ? 'pos' : e.amount < 0 ? 'neg' : 'dim'}">
            ${e.amount > 0 ? '+' : ''}${e.amount === 0 ? '±0' : n(e.amount)}</span>
        </div>`).join('')}</div>` : '<div class="empty">Nothing has happened yet. Suspicious.</div>'}
    </div>`;
}

function viewSetup() {
  const list = (items, kind, render) => items.length
    ? `<div class="table-wrap"><table><tbody>${items.map((it) => `<tr>
        <td>${render(it)}</td>
        <td class="num" style="width:1%"><button class="btn sm danger" data-del="${kind}|${it.id}">Remove</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">None yet.</div>`;

  return `
    <div class="section">
      <div class="section-head"><h2>Clubs</h2><span class="hint">${pool.clubs.length}</span></div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Club name</label><input type="text" id="clubName" placeholder="Wharton Investment &amp; Trading Group" /></div>
        <div class="field"><label>Note (optional)</label><input type="text" id="clubNote" placeholder="3 rounds, brutal" /></div>
        <button class="btn primary" id="addClub">Add club</button>
      </div>
      ${list(pool.clubs, 'club', (c) => `<b>${esc(c.name)}</b>${c.note ? ` <span class="dim">— ${esc(c.note)}</span>` : ''}`)}
    </div>

    <div class="section">
      <div class="section-head"><h2>Candidates</h2><span class="hint">${pool.candidates.length}</span></div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Name</label><input type="text" id="candName" placeholder="Jordan" /></div>
        <div class="field"><label>Year</label><input type="text" id="candYear" placeholder="'29" /></div>
        <div class="field"><label>School</label><input type="text" id="candSchool" placeholder="CAS" /></div>
        <button class="btn primary" id="addCand">Add candidate</button>
      </div>
      ${list(pool.candidates, 'candidate', (c) => `<b>${esc(c.name)}</b>
        <span class="dim">${[c.year, c.school].filter(Boolean).map(esc).join(' · ')}</span>`)}
    </div>

    <div class="section">
      <div class="section-head">
        <h2>Bettors</h2>
        <span class="hint">each starts with ${n(pool.settings.startingChips)} chips</span>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Name or nickname</label><input type="text" id="bettorName" placeholder="Eric" /></div>
        <button class="btn primary" id="addBettor">Add bettor</button>
      </div>
      ${list(pool.bettors, 'bettor', (b) => `<b>${esc(b.name)}</b>
        <span class="mono dim">${n(balance(b.id))} chips${atRisk(b.id) ? ` · ${n(atRisk(b.id))} at risk` : ''}</span>`)}
    </div>

    <div class="section">
      <div class="section-head"><h2>House rules</h2><span class="hint">applies to new bets</span></div>
      <div class="row">
        <div class="field"><label>Payout multiplier</label>
          <input type="number" id="setPayout" step="0.05" min="1" value="${pool.settings.payout}" /></div>
        <div class="field"><label>Starting chips</label>
          <input type="number" id="setStart" step="50" min="1" value="${pool.settings.startingChips}" /></div>
        <div class="field"><label>Cancel fee %</label>
          <input type="number" id="setFee" step="1" min="0" max="50" value="${Math.round(pool.settings.cancelFeePct * 100)}" /></div>
        <button class="btn primary" id="saveSettings">Save rules</button>
        <button class="btn ${pool.settings.locked ? 'primary' : ''}" id="toggleLock">
          ${pool.settings.locked ? 'Unlock pool' : 'Lock pool'}</button>
      </div>
      <p class="blurb" style="margin-top:10px">A ${pool.settings.payout}× payout means a winning 100
        returns ${n(Math.round(100 * pool.settings.payout))} — stake included. Changing the multiplier
        does not re-price bets already on the book.</p>
    </div>`;
}

function viewPool() {
  const counts = pool
    ? `${pool.clubs.length} clubs · ${pool.candidates.length} candidates · ${pool.bettors.length} bettors ·
       ${pool.bets.length} bets · ${pool.markets.length} markets`
    : '';
  return `
    <div class="section">
      <div class="section-head"><h2>This pool</h2><span class="hint">${counts}</span></div>
      <div class="row" style="margin-bottom:14px">
        <div class="field"><label>Pool name</label>
          <input type="text" id="poolName" value="${esc(pool.name)}" /></div>
        <button class="btn" id="renamePool">Rename</button>
      </div>
      <p class="blurb">Created ${new Date(pool.createdAt).toLocaleString()}. Everything lives in this
        browser's localStorage. There is no server, so the JSON file <i>is</i> the source of truth for
        the group — one person runs the house, exports after each change, and shares the file.</p>
      <div class="row">
        <button class="btn primary" id="exportPool">Export JSON</button>
        <button class="btn" id="importPool">Import JSON</button>
        <button class="btn" id="copyPool">Copy to clipboard</button>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Start over</h2></div>
      <p class="blurb">Export first. This cannot be undone and nobody will feel sorry for you.</p>
      <div class="row">
        <button class="btn" id="newPoolBtn">New empty pool</button>
        <button class="btn" id="demoBtn">Load demo data</button>
        <button class="btn danger" id="wipeBtn">Delete this pool</button>
      </div>
    </div>`;
}

function viewNoPool() {
  return `
    <div class="section" style="max-width:520px">
      <div class="section-head"><h2>New pool</h2><span class="hint">v1</span></div>
      <p class="blurb">A private, play-money market on who gets interviews and who gets in.
        No real money, no payments, no consequences beyond the group chat. Hedge the anxiety.</p>
      <div class="row">
        <div class="field"><label>Pool name</label>
          <input type="text" id="newPoolName" placeholder="Fall 2026 Recruiting" /></div>
        <button class="btn primary" id="createPool">Create</button>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="importPool">Import a pool file</button>
        <button class="btn ghost" id="demoBtn">Load demo data</button>
      </div>
    </div>`;
}

/* ── render + events ──────────────────────────────────────────────────────── */
function render() {
  const app = $('#app');
  $('#poolLabel').textContent = pool ? pool.name + (pool.settings.locked ? ' · locked' : '') : 'no pool loaded';

  if (!pool) {
    $('#tabs').style.display = 'none';
    ['metaBank', 'metaOpen', 'metaMarkets'].forEach((id) => { $('#' + id).textContent = '—'; });
    app.innerHTML = viewNoPool();
    return bindStatic(app);
  }
  $('#tabs').style.display = '';

  const bank = pool.bettors.reduce((s, b) => s + balance(b.id) + atRisk(b.id), 0);
  $('#metaBank').textContent = n(bank);
  $('#metaOpen').textContent = pool.bets.filter((b) => b.status === 'open').length;
  $('#metaMarkets').textContent = pool.candidates.length * pool.clubs.length;

  app.innerHTML =
    view === 'board' ? viewBoard() :
    view === 'house' ? viewHouse() :
    view === 'leaderboard' ? viewLeaderboard() :
    view === 'setup' ? viewSetup() : viewPool();

  bindStatic(app);
}

/** Wire up controls that only exist inside the freshly rendered view. */
function bindStatic(app) {
  const on = (sel, ev, fn) => { const el = $(sel, app); if (el) el.addEventListener(ev, fn); };

  on('#fClub', 'change', (e) => { filters.club = e.target.value; render(); });
  on('#fCand', 'change', (e) => { filters.candidate = e.target.value; render(); });
  on('#fSettled', 'click', () => { filters.hideSettled = !filters.hideSettled; render(); });
  on('#whoAmI', 'change', (e) => { me = e.target.value; localStorage.setItem(KEY_ME, me); render(); });
  const q = $('#fQ', app);
  if (q) {
    q.addEventListener('input', (e) => {
      filters.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const nq = $('#fQ');
      if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
    });
  }

  // setup
  on('#addClub', 'click', () => {
    const name = $('#clubName').value.trim();
    if (!name) return toast('name it first', true);
    pool.clubs.push({ id: uid('clb'), name, note: $('#clubNote').value.trim() });
    save(); render();
  });
  on('#addCand', 'click', () => {
    const name = $('#candName').value.trim();
    if (!name) return toast('name it first', true);
    pool.candidates.push({
      id: uid('cnd'), name,
      year: $('#candYear').value.trim(), school: $('#candSchool').value.trim()
    });
    save(); render();
  });
  on('#addBettor', 'click', () => {
    const name = $('#bettorName').value.trim();
    if (!name) return toast('name it first', true);
    const b = addBettor(name);
    if (!me) { me = b.id; localStorage.setItem(KEY_ME, me); }
    render();
  });
  on('#saveSettings', 'click', () => {
    const payout = Number($('#setPayout').value);
    const start = Math.floor(Number($('#setStart').value));
    const fee = clamp(Number($('#setFee').value), 0, 50) / 100;
    if (!(payout >= 1)) return toast('payout must be at least 1', true);
    if (!(start > 0)) return toast('starting chips must be positive', true);
    // Retro-adjust existing stacks so a mid-pool change to the starting stack is fair.
    if (start !== pool.settings.startingChips) {
      const delta = start - pool.settings.startingChips;
      for (const b of pool.bettors) entry(b.id, 'seed', delta, null, 'starting stack adjusted');
    }
    Object.assign(pool.settings, { payout, startingChips: start, cancelFeePct: fee });
    save(); render(); toast('Rules updated.');
  });
  on('#toggleLock', 'click', () => {
    pool.settings.locked = !pool.settings.locked;
    save(); render();
    toast(pool.settings.locked ? 'Pool locked.' : 'Pool open for business.');
  });

  // pool
  on('#createPool', 'click', () => {
    pool = newPool($('#newPoolName').value.trim() || 'Fall Recruiting');
    save(); view = 'setup'; syncTabs(); render();
  });
  on('#renamePool', 'click', () => {
    pool.name = $('#poolName').value.trim() || pool.name;
    save(); render(); toast('Renamed.');
  });
  on('#exportPool', 'click', exportPool);
  on('#copyPool', 'click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(pool, null, 2));
      toast('Pool JSON copied.');
    } catch { toast('Clipboard blocked — use Export.', true); }
  });
  on('#importPool', 'click', () => $('#fileInput').click());
  on('#newPoolBtn', 'click', () => {
    if (!confirm('Replace the current pool with an empty one?')) return;
    pool = newPool('Untitled Pool'); save(); view = 'setup'; syncTabs(); render();
  });
  on('#demoBtn', 'click', loadDemo);
  on('#wipeBtn', 'click', () => {
    if (!confirm('Delete this pool from the browser? Exported files are unaffected.')) return;
    localStorage.removeItem(KEY); pool = null; render();
  });
}

/* Delegated clicks for everything generated inside lists/cards. */
document.addEventListener('click', (e) => {
  const t = e.target;

  if (t.closest('[data-close]')) return closeModal();

  const bet = t.closest('[data-bet]');
  if (bet) {
    const [candidateId, clubId, leg, side] = bet.dataset.bet.split('|');
    return openSlip(candidateId, clubId, leg, side);
  }

  const edit = t.closest('[data-edit]');
  if (edit) {
    const b = byId(pool.bets, edit.dataset.edit);
    const m = byId(pool.markets, b.marketId);
    return openSlip(m.candidateId, m.clubId, b.leg, b.side, b.id);
  }

  const pull = t.closest('[data-cancelbet]');
  if (pull) {
    const b = byId(pool.bets, pull.dataset.cancelbet);
    const fee = Math.round(b.stake * pool.settings.cancelFeePct);
    if (!confirm(`Pull this bet? You get back ${n(b.stake - fee)} of ${n(b.stake)} (${n(fee)} fee).`)) return;
    cancelBet(b.id);
    return render();
  }

  const res = t.closest('[data-result]');
  if (res) {
    const [ref, leg, value] = res.dataset.result.split('|');
    let marketId = ref;
    if (ref.startsWith('new:')) {                 // market not created until it matters
      const [, candidateId, clubId] = ref.split(':');
      marketId = getMarket(candidateId, clubId, true).id;
    }
    if (value === 'pending') {
      const settledBets = pool.bets.filter(
        (b) => b.marketId === marketId && b.leg === leg && b.status !== 'open' && b.status !== 'cancelled');
      if (settledBets.length && !confirm(`Unwind ${settledBets.length} settled bet(s) on this leg?`)) return;
    }
    setResult(marketId, leg, value);
    return render();
  }

  const del = t.closest('[data-del]');
  if (del) {
    const [kind, id] = del.dataset.del.split('|');
    return removeEntity(kind, id);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});

function removeEntity(kind, id) {
  if (kind === 'bettor') {
    if (pool.bets.some((b) => b.bettorId === id && b.status === 'open')) {
      return toast('that bettor still has open positions', true);
    }
    if (!confirm(`Remove ${bettorName(id)}? Their history goes too.`)) return;
    pool.bettors = pool.bettors.filter((b) => b.id !== id);
    pool.bets = pool.bets.filter((b) => b.bettorId !== id);
    pool.ledger = pool.ledger.filter((l) => l.bettorId !== id);
    if (me === id) { me = null; localStorage.removeItem(KEY_ME); }
  } else {
    const field = kind === 'club' ? 'clubId' : 'candidateId';
    const mkts = pool.markets.filter((m) => m[field] === id).map((m) => m.id);
    if (pool.bets.some((b) => mkts.includes(b.marketId) && b.status !== 'cancelled')) {
      return toast('there are bets on that — settle or pull them first', true);
    }
    if (!confirm('Remove this and its markets?')) return;
    pool.markets = pool.markets.filter((m) => m[field] !== id);
    if (kind === 'club') pool.clubs = pool.clubs.filter((c) => c.id !== id);
    else pool.candidates = pool.candidates.filter((c) => c.id !== id);
  }
  save(); render();
}

/* ── import / export ──────────────────────────────────────────────────────── */
function exportPool() {
  const slug = pool.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pool';
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(pool, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clubhedge-${slug}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Exported. Drop it in the group chat.');
}

$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = migrate(JSON.parse(reader.result));
      if (pool && !confirm(`Replace "${pool.name}" with "${incoming.name}"? Export yours first if it matters.`)) return;
      pool = incoming; save(); view = 'board'; syncTabs(); render();
      toast(`Loaded "${pool.name}".`);
    } catch (err) {
      toast('That file is not a ClubHedge pool.', true);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

/* ── demo data ────────────────────────────────────────────────────────────── */
function loadDemo() {
  if (pool && !confirm('Replace the current pool with demo data?')) return;
  pool = newPool('Fall 2026 Recruiting');
  const clubs = [
    ['Wharton Investment & Trading', '3 rounds, brutal'],
    ['Penn Consulting Group', 'case prep purgatory'],
    ['Weiss Tech House', 'vibes-based']
  ].map(([name, note]) => { const c = { id: uid('clb'), name, note }; pool.clubs.push(c); return c; });
  const cands = [
    ['Jordan', "'29", 'CAS'], ['Priya', "'28", 'Wharton'], ['Marcus', "'29", 'SEAS']
  ].map(([name, year, school]) => {
    const c = { id: uid('cnd'), name, year, school }; pool.candidates.push(c); return c;
  });
  const bettors = ['Eric', 'Sam', 'Nina'].map((nm) => addBettor(nm));

  // A few plausible positions so the board isn't a ghost town.
  const seedBets = [
    [cands[0], clubs[0], 'interview', 'yes', 200, bettors[0]],
    [cands[0], clubs[0], 'acceptance', 'no', 150, bettors[1]],
    [cands[1], clubs[1], 'interview', 'yes', 300, bettors[2]],
    [cands[2], clubs[2], 'interview', 'no', 120, bettors[0]]
  ];
  for (const [cand, club, leg, side, stake, bettor] of seedBets) {
    const m = getMarket(cand.id, club.id, true);
    placeBet(m.id, leg, bettor.id, side, stake);
  }
  me = bettors[0].id;
  localStorage.setItem(KEY_ME, me);
  save(); view = 'board'; syncTabs(); render();
  toast('Demo pool loaded.');
}

/* ── tabs / boot ──────────────────────────────────────────────────────────── */
function syncTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.view === view);
  });
}
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  view = t.dataset.view;
  syncTabs();
  render();
});

load();
syncTabs();
render();
