// ══════════════════════════════════════════════════════════════════
// EVENT BUS — un produttore, molti consumatori indipendenti.
//
// PERCHÉ ESISTE: senza di esso, ogni volta che aggiungi un consumatore
// (Telegram, poi la dashboard, poi un'app mobile, poi l'AI Performance
// Engine) devi modificare l'orchestratore. Con esso, aggiungere un
// consumatore non tocca una riga di ciò che già funziona.
//
// GARANZIA FONDAMENTALE — ISOLAMENTO DEI CONSUMATORI:
// se un consumatore va in errore (Telegram non raggiungibile, database
// momentaneamente giù), gli altri consumatori ricevono l'evento
// normalmente e il produttore non si accorge di nulla. Un guasto in un
// canale di notifica NON deve mai impedire il salvataggio dei dati né
// bloccare il ciclo di analisi.
// Questo è lo stesso principio di isolamento già applicato in tutto il
// progetto tra motore e diagnostica: chi osserva non può rompere chi decide.

// ── Tipi di evento dichiarati: nessuna stringa sparsa nel codice ──
var EVENTS = {
  // ciclo di analisi
  CYCLE_STARTED: 'cycle.started',
  CYCLE_COMPLETED: 'cycle.completed',
  CYCLE_SKIPPED: 'cycle.skipped',          // anti-ricalcolo: nulla di nuovo
  CYCLE_MARKET_CLOSED: 'cycle.marketClosed', // mercato chiuso: nessuna analisi, nessuna notifica
  CYCLE_FAILED: 'cycle.failed',

  // dati di mercato
  MARKET_DATA_UPDATED: 'marketData.updated',
  MARKET_DATA_FAILED: 'marketData.failed',

  // ciclo di vita del setup (mappati sugli stati che il motore già produce)
  SETUP_CREATED: 'setup.created',
  SETUP_UPDATED: 'setup.updated',
  SETUP_TOUCHED: 'setup.touched',
  SETUP_CONFIRMED: 'setup.confirmed',
  SETUP_TRADE_READY: 'setup.tradeReady',
  SETUP_PENDING_LIMIT: 'setup.pendingLimit',
  SETUP_INVALIDATED: 'setup.invalidated',
  SETUP_EXPIRED: 'setup.expired',
  SETUP_MISSED: 'setup.missed',
  SETUP_TARGET_HIT: 'setup.targetHit', // segnale GREZZO del motore (TARGET_HIT) — di competenza di Position Tracker, non un evento posizione finale

  // esiti (generati dal Position Tracker, Fase 3)
  POSITION_OPENED: 'position.opened',
  POSITION_TP1_HIT: 'position.tp1Hit',
  POSITION_TP2_HIT: 'position.tp2Hit',
  POSITION_SL_HIT: 'position.slHit',
  POSITION_CLOSED: 'position.closed',

  // radar
  RADAR_OPPORTUNITY: 'radar.opportunity',

  // news (Fase 5)
  NEWS_UPDATED: 'news.updated',
  NEWS_HIGH_IMPACT_UPCOMING: 'news.highImpactUpcoming',
  NEWS_LOCK_ACTIVATED: 'news.lockActivated',
  NEWS_LOCK_RELEASED: 'news.lockReleased',

  // decision gate (Fase 5)
  DECISION_BLOCKED: 'decision.blocked',
  DECISION_ACTIONABLE: 'decision.actionable',

  // sistema
  SERVICE_STARTED: 'service.started',
  SERVICE_ERROR: 'service.error'
};

var handlers = {};        // eventType -> [{name, fn}]
var wildcardHandlers = []; // ricevono TUTTI gli eventi
var history = [];          // ultimi N eventi, per diagnosi
var HISTORY_MAX = 200;
var onHandlerError = null; // callback opzionale per registrare gli errori dei consumatori

function subscribe(eventType, handlerName, fn) {
  if (typeof handlerName === 'function') { fn = handlerName; handlerName = 'anonimo'; }
  if (eventType === '*') {
    wildcardHandlers.push({ name: handlerName, fn: fn });
    return;
  }
  if (!handlers[eventType]) handlers[eventType] = [];
  handlers[eventType].push({ name: handlerName, fn: fn });
}

function publish(eventType, payload) {
  var event = { type: eventType, at: Date.now(), payload: payload || {} };

  history.push(event);
  if (history.length > HISTORY_MAX) history.shift();

  var targets = (handlers[eventType] || []).concat(wildcardHandlers);

  targets.forEach(function (h) {
    // ISOLAMENTO: ogni consumatore è racchiuso nel suo try/catch.
    // Un errore qui non risale mai al produttore né agli altri consumatori.
    try {
      var result = h.fn(event);
      // se il consumatore è asincrono, catturiamo anche i suoi errori
      if (result && typeof result.catch === 'function') {
        result.catch(function (err) { reportHandlerError(h.name, eventType, err); });
      }
    } catch (err) {
      reportHandlerError(h.name, eventType, err);
    }
  });

  return event;
}

function reportHandlerError(handlerName, eventType, err) {
  var msg = '[event-bus] il consumatore "' + handlerName + '" è andato in errore su ' +
    eventType + ': ' + (err && err.message ? err.message : String(err));
  if (onHandlerError) {
    try { onHandlerError({ handler: handlerName, eventType: eventType, error: err, message: msg }); }
    catch (e) { console.error(msg); }
  } else {
    console.error(msg);
  }
}

function setErrorReporter(fn) { onHandlerError = fn; }

function getHistory(limit) { return history.slice(-(limit || 50)); }

function listSubscribers() {
  var out = {};
  Object.keys(handlers).forEach(function (t) { out[t] = handlers[t].map(function (h) { return h.name; }); });
  if (wildcardHandlers.length) out['*'] = wildcardHandlers.map(function (h) { return h.name; });
  return out;
}

// per i test: azzera tutto
function reset() { handlers = {}; wildcardHandlers = []; history = []; onHandlerError = null; }

module.exports = {
  EVENTS: EVENTS,
  publish: publish,
  subscribe: subscribe,
  getHistory: getHistory,
  listSubscribers: listSubscribers,
  setErrorReporter: setErrorReporter,
  reset: reset
};
