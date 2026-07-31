// ══════════════════════════════════════════════════════════════════
// POSITION TRACKER — segue un'operazione dall'apertura alla chiusura,
// con entry/uscita/guadagno precisi.
//
// DECISIONE ARCHITETTURALE CENTRALE, verificata nel codice reale prima
// di scrivere una riga: il motore GIÀ dichiara da solo quando un trade
// aperto finisce — con due meccanismi distinti:
//   · INVALIDATED (equivalente allo Stop Loss): quando una chiusura M15
//     supera il livello strutturale di invalidazione
//   · TARGET_HIT (equivalente al Take Profit): quando il prezzo LIVE
//     raggiunge il target
// Questo Position Tracker NON re-implementa un controllo indipendente
// su alte/basse delle candele (come faceva il backtest) — sarebbe un
// SECONDO decisore che potrebbe non essere d'accordo col motore, esatto
// il tipo di rischio ("due fotografie diverse del mercato") che questo
// intero progetto ha sempre evitato. Si limita a OSSERVARE le due
// decisioni che il motore ha già preso, e le traduce in un evento di
// posizione con numeri precisi (entry/uscita/guadagno in R).
//
// TP2 NON è un evento di chiusura: verificato nel motore che, una volta
// che una posizione è aperta (stato ACTIVATED), target2 non viene MAI
// usato come secondo obiettivo dal vivo — la promozione a target2
// avviene SOLO prima dell'apertura (durante la conferma), mai dopo.
// TP2 resta quindi puramente informativo (mostrato all'utente), mai un
// evento di chiusura reale: costruirlo significherebbe inventare un
// comportamento che il motore testato non ha.
//
// Una sola posizione alla volta per simbolo — coerente con lo stesso
// principio "un solo tracker attivo" già verificato nel motore.

var store = null; // iniettato all'attach, per i test

function keyFor(symbol) { return 'position_' + symbol.replace('/', ''); }

function openPosition(symbol, ev, storeRef, log) {
  var p = ev.payload;
  var existing = storeRef.load(keyFor(symbol), null);
  if (existing && existing.setupId !== p.setupId) {
    // non dovrebbe mai accadere (il motore mantiene un solo tracker
    // attivo per simbolo, verificato più volte) — se succede, è un
    // segnale da indagare, non un'apertura silenziosa di una seconda
    // posizione parallela.
    log.warn('position.conflict', 'un nuovo TRADE_READY è arrivato mentre una posizione diversa risultava già aperta', {
      symbol: symbol, existingSetupId: existing.setupId, newSetupId: p.setupId
    });
    return null;
  }
  if (existing && existing.setupId === p.setupId) return null; // stessa posizione, nessuna riapertura

  var position = {
    symbol: symbol, setupId: p.setupId, direction: p.direction,
    entryPrice: p.entryLo, sl: p.sl, tp1: p.tp1, tp2: p.tp2, tpFast: p.tpFast,
    orderType: p.orderType, executionMode: p.executionMode,
    openedAt: ev.at, status: 'OPEN'
  };
  storeRef.save(keyFor(symbol), position);
  return position;
}

function computePnlR(position, exitPrice) {
  var risk = Math.abs(position.entryPrice - position.sl);
  if (!(risk > 0) || exitPrice === null || exitPrice === undefined) return null;
  var pnl = position.direction === 'BUY' ? (exitPrice - position.entryPrice) : (position.entryPrice - exitPrice);
  return pnl / risk;
}

function closePosition(symbol, exitPrice, exitReason, ev, storeRef) {
  var position = storeRef.load(keyFor(symbol), null);
  if (!position || position.setupId !== ev.payload.setupId) return null; // non è la posizione che stiamo seguendo

  var closed = Object.assign({}, position, {
    status: 'CLOSED', closedAt: ev.at, exitPrice: exitPrice, exitReason: exitReason,
    pnlR: computePnlR(position, exitPrice)
  });
  storeRef.save(keyFor(symbol), null); // libera lo slot: la prossima SETUP_TRADE_READY potrà aprirne una nuova
  return closed;
}

function attach(bus, config, logging, storeOverride) {
  storeRef = storeOverride || require('../persistence/stateStore.js');
  var log = logging.forComponent('position-tracker');

  bus.subscribe(bus.EVENTS.SETUP_TRADE_READY, 'position-tracker', function (ev) {
    var symbol = ev.payload.symbol;
    var position = openPosition(symbol, ev, storeRef, log);
    if (position) {
      log.info('position.opened', 'posizione aperta', { symbol: symbol, setupId: position.setupId, entry: position.entryPrice, sl: position.sl, tp1: position.tp1 });
      bus.publish(bus.EVENTS.POSITION_OPENED, position);
    }
  });

  bus.subscribe(bus.EVENTS.SETUP_INVALIDATED, 'position-tracker', function (ev) {
    var symbol = ev.payload.symbol;
    // prezzo di riferimento dell'uscita: il livello strutturale stesso
    // (lo stesso "SL" già mostrato all'utente nel piano) — scelta
    // deliberata, non un'approssimazione a caso: è il numero che
    // l'utente ha visto come proprio stop, quindi è il riferimento più
    // intuitivo e tracciabile per "sono uscito qui".
    var exitPrice = ev.payload.invalid !== undefined ? ev.payload.invalid : null;
    var closed = closePosition(symbol, exitPrice, 'SL', ev, storeRef);
    if (closed) {
      log.info('position.closed', 'posizione chiusa in stop loss', { symbol: symbol, setupId: closed.setupId, exitPrice: exitPrice, pnlR: closed.pnlR });
      bus.publish(bus.EVENTS.POSITION_SL_HIT, closed);
      bus.publish(bus.EVENTS.POSITION_CLOSED, closed);
    }
  });

  bus.subscribe(bus.EVENTS.SETUP_TARGET_HIT, 'position-tracker', function (ev) {
    var symbol = ev.payload.symbol;
    var openPos = storeRef.load(keyFor(symbol), null);
    // qui il motore ha già registrato il prezzo LIVE nel momento in cui
    // il target è stato raggiunto (priceAtEvent, aggiunto dall'orchestratore
    // proprio per questo scopo) — è il riferimento più fedele possibile
    // alla decisione reale del motore. Se per qualche motivo mancasse,
    // ripiega sul target della posizione tracciata (mai un valore a caso).
    var exitPrice = ev.payload.priceAtEvent !== undefined && ev.payload.priceAtEvent !== null
      ? ev.payload.priceAtEvent
      : (openPos ? openPos.tp1 : null);
    var closed = closePosition(symbol, exitPrice, 'TP1', ev, storeRef);
    if (closed) {
      log.info('position.closed', 'posizione chiusa in target', { symbol: symbol, setupId: closed.setupId, exitPrice: exitPrice, pnlR: closed.pnlR });
      bus.publish(bus.EVENTS.POSITION_TP1_HIT, closed);
      bus.publish(bus.EVENTS.POSITION_CLOSED, closed);
    }
  });

  log.info('tracker.attached', 'Position Tracker collegato all\'Event Bus');
  return true;
}

var storeRef = null;

function getOpenPosition(symbol) {
  return (storeRef || require('../persistence/stateStore.js')).load(keyFor(symbol), null);
}

module.exports = { attach: attach, getOpenPosition: getOpenPosition, computePnlR: computePnlR };
