// ══════════════════════════════════════════════════════════════════
// SETUPS REPOSITORY — scrive la tabella setups (una riga per setupId,
// aggiornata mentre vive) e setup_events (la cronologia immutabile).
//
// COALESCE: un evento non porta sempre TUTTI i campi (per esempio
// INVALIDATED porta l'esito ma non necessariamente un nuovo SL/TP).
// COALESCE(nuovo_valore, valore_già_salvato) evita di cancellare un
// dato buono con un NULL involontario.

var db = require('./index.js');

function pick(obj, key) { return obj && obj[key] !== undefined ? obj[key] : null; }

async function upsertSetup(ev) {
  var p = ev.payload;
  if (!p.setupId) return; // eventi senza setup (es. radar) non toccano questa tabella

  var q = ev.payload.quality || {};
  var ms = ev.payload.marketStructure || null;
  var zones = ev.payload.zones || null;

  await db.query(
    'INSERT INTO setups (' +
    '  id, symbol, direction, created_at, updated_at, execution_mode, order_type, status,' +
    '  bias, grade, confidence, entry_lo, entry_hi, sl, tp1, tp2, tp_fast, rr1, rr2, required_rr,' +
    '  invalidation_level, atr_h1, atr_m15, market_structure, zones, quality_factors, reason,' +
    '  terminal_at, outcome' +
    ') VALUES (' +
    '  $1,$2,$3,$4, now(), $5,$6,$7,' +
    '  $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,' +
    '  $20,$21,$22,$23,$24,$25,$26,' +
    '  $27,$28' +
    ') ON CONFLICT (symbol, id) DO UPDATE SET' +
    '  updated_at = now(),' +
    '  execution_mode = COALESCE(EXCLUDED.execution_mode, setups.execution_mode),' +
    '  order_type      = COALESCE(EXCLUDED.order_type, setups.order_type),' +
    '  status          = COALESCE(EXCLUDED.status, setups.status),' +
    '  bias            = COALESCE(EXCLUDED.bias, setups.bias),' +
    '  grade           = COALESCE(EXCLUDED.grade, setups.grade),' +
    '  confidence      = COALESCE(EXCLUDED.confidence, setups.confidence),' +
    '  entry_lo        = COALESCE(EXCLUDED.entry_lo, setups.entry_lo),' +
    '  entry_hi        = COALESCE(EXCLUDED.entry_hi, setups.entry_hi),' +
    '  sl              = COALESCE(EXCLUDED.sl, setups.sl),' +
    '  tp1             = COALESCE(EXCLUDED.tp1, setups.tp1),' +
    '  tp2             = COALESCE(EXCLUDED.tp2, setups.tp2),' +
    '  tp_fast         = COALESCE(EXCLUDED.tp_fast, setups.tp_fast),' +
    '  rr1             = COALESCE(EXCLUDED.rr1, setups.rr1),' +
    '  rr2             = COALESCE(EXCLUDED.rr2, setups.rr2),' +
    '  required_rr     = COALESCE(EXCLUDED.required_rr, setups.required_rr),' +
    '  invalidation_level = COALESCE(EXCLUDED.invalidation_level, setups.invalidation_level),' +
    '  atr_h1          = COALESCE(EXCLUDED.atr_h1, setups.atr_h1),' +
    '  atr_m15         = COALESCE(EXCLUDED.atr_m15, setups.atr_m15),' +
    '  market_structure = COALESCE(EXCLUDED.market_structure, setups.market_structure),' +
    '  zones           = COALESCE(EXCLUDED.zones, setups.zones),' +
    '  quality_factors = COALESCE(EXCLUDED.quality_factors, setups.quality_factors),' +
    '  reason          = COALESCE(EXCLUDED.reason, setups.reason),' +
    '  terminal_at     = COALESCE(EXCLUDED.terminal_at, setups.terminal_at),' +
    '  outcome         = COALESCE(EXCLUDED.outcome, setups.outcome)',
    [
      p.setupId, ev.payload.symbol, p.direction || null, new Date(ev.at), // 1-4
      p.executionMode || null, p.orderType || null, p.status || null, // 5-7
      p.bias || null, q.grade || null, q.confidence !== undefined ? q.confidence : null, // 8-10
      p.entryLo !== undefined ? p.entryLo : null, p.entryHi !== undefined ? p.entryHi : null, // 11-12
      p.sl !== undefined ? p.sl : null, p.tp1 !== undefined ? p.tp1 : null, p.tp2 !== undefined ? p.tp2 : null, // 13-15
      p.tpFast !== undefined ? p.tpFast : null, p.rr1 !== undefined ? p.rr1 : null, p.rr2 !== undefined ? p.rr2 : null, // 16-18
      p.requiredRR !== undefined ? p.requiredRR : null, p.invalid !== undefined ? p.invalid : null, // 19-20
      p.atrH1 !== undefined ? p.atrH1 : null, p.atrM15 !== undefined ? p.atrM15 : null, // 21-22
      ms ? JSON.stringify(ms) : null, zones ? JSON.stringify(zones) : null, // 23-24
      q.factors ? JSON.stringify(q.factors) : null, p.reason || null, // 25-26
      p.outcome ? new Date(ev.at) : null, p.outcome || null // 27-28
    ]
  );
}

async function insertEvent(ev) {
  var p = ev.payload;
  if (!p.setupId) return;

  await db.query(
    'INSERT INTO setup_events (setup_id, symbol, at, event_type, from_state, to_state, reason, payload) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [p.setupId, p.symbol, new Date(ev.at), ev.type, p.from || null, p.to || p.status || null, p.reason || null, JSON.stringify(p)]
  );
}

// Un evento di ciclo di vita del setup comporta SEMPRE due scritture,
// in quest'ordine (il vincolo di integrità referenziale lo richiede:
// l'evento punta a un setup che deve già esistere).
async function recordSetupLifecycleEvent(ev) {
  await upsertSetup(ev);
  await insertEvent(ev);
}

async function insertAnalysis(ev) {
  var snap = ev.payload.snapshot;
  if (!snap) return;
  await db.query(
    'INSERT INTO analyses (symbol, at, price, bias, grade, confidence, execution_mode, decision, status, reason) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      snap.symbol, new Date(snap.generatedAt), snap.price, snap.bias ? snap.bias.bias : null,
      snap.plan.quality ? snap.plan.quality.grade : null,
      snap.plan.quality ? snap.plan.quality.confidence : null,
      snap.plan.executionMode || null,
      (snap.plan.action === 'PLAN' && snap.plan.status === 'TRADE_READY') ? 'TRADE' : 'NO_TRADE',
      snap.plan.status || null, snap.plan.reason || null
    ]
  );
}

async function insertLog(record) {
  await db.query(
    'INSERT INTO logs (at, level, component, event_type, message, context) VALUES ($1,$2,$3,$4,$5,$6)',
    [new Date(record.at), record.level, record.component, record.event || null, record.message, record.context ? JSON.stringify(record.context) : null]
  );
}

async function insertPosition(position) {
  await db.query(
    'INSERT INTO positions (symbol, setup_id, direction, entry_price, sl, tp1, tp2, tp_fast, order_type, execution_mode, opened_at, status) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      position.symbol, position.setupId, position.direction, position.entryPrice, position.sl,
      position.tp1, position.tp2, position.tpFast, position.orderType, position.executionMode,
      new Date(position.openedAt), 'OPEN'
    ]
  );
}

async function closePositionRecord(position) {
  await db.query(
    'UPDATE positions SET closed_at=$1, exit_price=$2, exit_reason=$3, pnl_r=$4, status=\'CLOSED\' ' +
    'WHERE symbol=$5 AND setup_id=$6 AND status=\'OPEN\'',
    [new Date(position.closedAt), position.exitPrice, position.exitReason, position.pnlR, position.symbol, position.setupId]
  );

  // Aggiorna anche setups con i dati DEFINITIVI e precisi del trade —
  // sovrascrive qualunque valore "evolutivo" lasciato dai cicli precedenti,
  // perché qui l'informazione è autorevole (Position Tracker, non il
  // generico aggiornamento per-ciclo).
  await db.query(
    'UPDATE setups SET terminal_at=$1, outcome=$2, exit_price=$3, pnl_r=$4, updated_at=now() ' +
    'WHERE symbol=$5 AND id=$6',
    [new Date(position.closedAt), position.exitReason, position.exitPrice, position.pnlR, position.symbol, position.setupId]
  );
}

module.exports = {
  recordSetupLifecycleEvent: recordSetupLifecycleEvent,
  insertAnalysis: insertAnalysis,
  insertLog: insertLog,
  insertPosition: insertPosition,
  closePositionRecord: closePositionRecord
};
