// ══════════════════════════════════════════════════════════════════
// MEASUREMENT LAYER — registra ogni decisione, comprese quelle bloccate,
// e ne osserva l'esito ipotetico.
//
// PROBLEMA CHE RISOLVE: quando il Decision Gate blocca un setup (per
// news o per rischio), quel setup non viene mai aperto — quindi non
// esiste alcun modo di sapere se il blocco ci ha protetti o ci ha tolto
// un'occasione. Senza questo dato, ogni filtro futuro sarebbe una
// scommessa non verificabile.
//
// COME FUNZIONA, senza duplicare nulla:
// Verificato nel codice che il Decision Gate blocca soltanto la
// PUBBLICAZIONE dell'evento operativo — il motore continua a seguire
// quel setup normalmente e continuerà a emettere SETUP_TARGET_HIT o
// SETUP_INVALIDATED quando il prezzo raggiunge quei livelli.
//
// Questo modulo quindi NON ricontrolla i prezzi e NON costruisce un
// secondo osservatore: ascolta esattamente gli stessi segnali che il
// motore già produce, con lo stesso identico principio già applicato a
// Position Tracker. Osserva, non decide.
//
// GARANZIA: nessuna modifica al motore, nessuna influenza sulle
// decisioni. Se questo modulo fallisse del tutto, il sistema si
// comporterebbe esattamente come oggi.

var repo = null;
var storeRef = null;
var log = null;

function keyFor(symbol) { return 'blocked_pending_' + symbol.replace('/', ''); }

// Setup bloccati in attesa di sapere come sarebbero andati.
// Vivono su file (non solo in memoria) per sopravvivere ai riavvii:
// un setup bloccato può risolversi ore dopo.
function loadPending(symbol) { return storeRef.load(keyFor(symbol), {}) || {}; }
function savePending(symbol, pending) { storeRef.save(keyFor(symbol), pending); }

function computeHypotheticalR(entry, sl, exitPrice, direction) {
  if (entry === null || sl === null || exitPrice === null) return null;
  var risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  var pnl = direction === 'BUY' ? (exitPrice - entry) : (entry - exitPrice);
  return Math.round((pnl / risk) * 100) / 100;
}

function attach(bus, config, logging, deps) {
  storeRef = deps.store;
  repo = deps.repo;
  log = logging.forComponent('measurement');
  var dbEnabled = config.get().database.enabled;

  // ── 1. REGISTRA il blocco nel momento in cui avviene ──
  bus.subscribe(bus.EVENTS.DECISION_BLOCKED, 'measurement', function (ev) {
    var p = ev.payload;
    if (!p.setupId) return;

    var pending = loadPending(p.symbol);
    // Un setup può essere bloccato per più cicli consecutivi: registriamo
    // solo il PRIMO blocco, con i livelli di quel momento. I blocchi
    // successivi dello stesso setup non creano righe duplicate.
    if (pending[p.setupId]) return;

    pending[p.setupId] = {
      setupId: p.setupId, symbol: p.symbol, direction: p.direction,
      blockedAt: ev.at, blockedBy: p.blockedBy, blockReason: p.gateReason,
      entry: p.entryLo !== undefined ? p.entryLo : null,
      sl: p.sl !== undefined ? p.sl : null,
      tp1: p.tp1 !== undefined ? p.tp1 : null,
      grade: p.quality ? p.quality.grade : null,
      confidence: p.quality ? p.quality.confidence : null,
      executionMode: p.executionMode || null
    };
    savePending(p.symbol, pending);

    log.info('decision.blocked.recorded', 'setup bloccato registrato per la misurazione', {
      setupId: p.setupId, blockedBy: p.blockedBy, grade: pending[p.setupId].grade
    });

    if (dbEnabled) {
      repo.insertBlockedDecision(pending[p.setupId]).catch(function (err) {
        log.error('write.failed', 'registrazione blocco fallita', { error: err.message, setupId: p.setupId });
      });
    }
  });

  // ── 2. OSSERVA l'esito, usando gli stessi segnali del motore ──
  // Nessun controllo indipendente sui prezzi: il motore dichiara da solo
  // quando un setup raggiunge il target o viene invalidato.

  function resolve(ev, outcome, exitPrice) {
    var p = ev.payload;
    if (!p.setupId || !p.symbol) return;

    var pending = loadPending(p.symbol);
    var blocked = pending[p.setupId];
    if (!blocked) return; // non era un setup bloccato: non ci riguarda

    var hypotheticalR = computeHypotheticalR(blocked.entry, blocked.sl, exitPrice, blocked.direction);

    delete pending[p.setupId];
    savePending(p.symbol, pending);

    log.info('blocked.resolved', 'esito ipotetico di un setup bloccato', {
      setupId: p.setupId, blockedBy: blocked.blockedBy, outcome: outcome,
      hypotheticalR: hypotheticalR, grade: blocked.grade
    });

    if (dbEnabled) {
      repo.resolveBlockedDecision({
        symbol: p.symbol, setupId: p.setupId, outcome: outcome,
        exitPrice: exitPrice, hypotheticalR: hypotheticalR, resolvedAt: ev.at
      }).catch(function (err) {
        log.error('write.failed', 'risoluzione blocco fallita', { error: err.message, setupId: p.setupId });
      });
    }
  }

  bus.subscribe(bus.EVENTS.SETUP_TARGET_HIT, 'measurement', function (ev) {
    var exit = ev.payload.priceAtEvent !== undefined ? ev.payload.priceAtEvent : null;
    resolve(ev, 'WOULD_HIT_TP', exit);
  });

  bus.subscribe(bus.EVENTS.SETUP_INVALIDATED, 'measurement', function (ev) {
    var exit = ev.payload.invalid !== undefined ? ev.payload.invalid : null;
    resolve(ev, 'WOULD_HIT_SL', exit);
  });

  // Un setup scaduto non è né un successo né un fallimento: va contato
  // a parte, altrimenti falserebbe le statistiche in un senso o nell'altro.
  bus.subscribe(bus.EVENTS.SETUP_EXPIRED, 'measurement', function (ev) {
    resolve(ev, 'EXPIRED', null);
  });

  log.info('measurement.attached', 'Measurement Layer collegato', { database: dbEnabled });
  return true;
}

function getPending(symbol) { return loadPending(symbol); }

module.exports = { attach: attach, getPending: getPending, computeHypotheticalR: computeHypotheticalR };
