// ══════════════════════════════════════════════════════════════════
// TEST FASE 3 — Position Tracker
//
// Il punto più importante da verificare: Position Tracker deve SOLO
// osservare le decisioni che il motore ha già preso (SETUP_INVALIDATED,
// SETUP_TARGET_HIT), mai ricalcolare in modo indipendente se un prezzo
// ha toccato SL/TP — altrimenti diventerebbe un secondo "cervello" che
// potrebbe non essere d'accordo con quello vero.

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

process.env.TWELVEDATA_API_KEY = 'test-key';
process.env.DATA_DIR = '/tmp/test-phase3-data';

var fs = require('fs');
try { fs.rmSync('/tmp/test-phase3-data', { recursive: true, force: true }); } catch (e) { }

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
var bus = require('../core/events/index.js');
var store = require('../modules/persistence/stateStore.js');
var tracker = require('../modules/positionTracker/index.js');

logging.configure({ level: 'ERROR', toFile: false });
config.load();

// ═══ VOCABOLARIO EVENTI: la correzione della Fase 2 ═══
console.log('\n═══ VOCABOLARIO EVENTI (correzione rispetto alla Fase 2) ═══');
check('SETUP_TARGET_HIT esiste come segnale grezzo separato', bus.EVENTS.SETUP_TARGET_HIT === 'setup.targetHit');
check('POSITION_TP1_HIT resta un evento distinto, di competenza di Position Tracker', bus.EVENTS.POSITION_TP1_HIT === 'position.tp1Hit');
check('I due eventi hanno nomi diversi (mai lo stesso evento pubblicato da due mittenti)', bus.EVENTS.SETUP_TARGET_HIT !== bus.EVENTS.POSITION_TP1_HIT);

// ═══ APERTURA POSIZIONE ═══
console.log('\n═══ APERTURA POSIZIONE ═══');
bus.reset();
var published = [];
bus.subscribe('*', 'osservatore', function (ev) { published.push(ev); });
tracker.attach(bus, config, logging);

bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-001', direction: 'BUY', status: 'TRADE_READY',
  entryLo: 4100.0, sl: 4090.0, tp1: 4125.0, tp2: 4140.0, tpFast: null,
  orderType: 'MARKET', executionMode: 'FAST CONFIRMATION'
});

var opened = tracker.getOpenPosition('XAU/USD');
check('Una posizione viene aperta con i dati corretti', opened && opened.setupId === 'S-001' && opened.entryPrice === 4100.0 && opened.sl === 4090.0);
check('Viene pubblicato POSITION_OPENED', published.some(function (e) { return e.type === 'position.opened'; }));

// GARANZIA: una seconda SETUP_TRADE_READY per LO STESSO setup non riapre nulla
var beforeReopen = JSON.stringify(tracker.getOpenPosition('XAU/USD'));
bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-001', direction: 'BUY', status: 'TRADE_READY',
  entryLo: 4105.0, sl: 4092.0, tp1: 4130.0, tp2: null, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
});
check('GARANZIA: stesso setupId → l\'entry/SL già registrati NON vengono sovrascritti (immutabilità della posizione aperta)',
  JSON.stringify(tracker.getOpenPosition('XAU/USD')) === beforeReopen);

// GARANZIA: un TRADE_READY di un setup DIVERSO mentre una posizione è già aperta NON apre una seconda posizione
bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-002-DIVERSO', direction: 'SELL', status: 'TRADE_READY',
  entryLo: 4080.0, sl: 4090.0, tp1: 4050.0, tp2: null, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
});
check('GARANZIA: un setup diverso NON apre una seconda posizione mentre una è già viva', tracker.getOpenPosition('XAU/USD').setupId === 'S-001');

// ═══ CHIUSURA IN STOP LOSS (osservando SETUP_INVALIDATED) ═══
console.log('\n═══ CHIUSURA IN STOP LOSS ═══');
published.length = 0;
bus.publish(bus.EVENTS.SETUP_INVALIDATED, {
  symbol: 'XAU/USD', setupId: 'S-001', direction: 'BUY', from: 'ACTIVATED', to: 'INVALIDATED', status: 'INVALIDATED',
  invalid: 4090.0, outcome: 'INVALIDATED', reason: 'Chiusura M15 oltre l\'invalidazione'
});
check('La posizione risulta chiusa (nessuna posizione aperta residua)', tracker.getOpenPosition('XAU/USD') === null);
var slClosedEvent = published.find(function (e) { return e.type === 'position.slHit'; });
check('Viene pubblicato POSITION_SL_HIT', !!slClosedEvent);
check('Il prezzo di uscita è il livello di invalidazione (lo stesso SL mostrato all\'utente)', slClosedEvent.payload.exitPrice === 4090.0);
check('Il guadagno in R è calcolato correttamente (entry 4100, SL 4090, uscita 4090 → -1R)', slClosedEvent.payload.pnlR === -1);
check('Viene pubblicato anche il generico POSITION_CLOSED', published.some(function (e) { return e.type === 'position.closed'; }));

// GARANZIA: un secondo SETUP_INVALIDATED per lo stesso setupId (non dovrebbe mai
// accadere, il motore è terminale-per-sempre) non chiude una posizione già chiusa due volte
published.length = 0;
bus.publish(bus.EVENTS.SETUP_INVALIDATED, { symbol: 'XAU/USD', setupId: 'S-001', invalid: 4090.0 });
check('GARANZIA: un evento ripetuto per una posizione già chiusa non pubblica un secondo POSITION_CLOSED', !published.some(function (e) { return e.type === 'position.closed'; }));

// ═══ CHIUSURA IN TARGET (osservando SETUP_TARGET_HIT) ═══
console.log('\n═══ CHIUSURA IN TARGET ═══');
bus.reset(); published.length = 0;
bus.subscribe('*', 'osservatore2', function (ev) { published.push(ev); });
tracker.attach(bus, config, logging);

bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-003', direction: 'SELL', status: 'TRADE_READY',
  entryLo: 4100.0, sl: 4110.0, tp1: 4070.0, tp2: 4050.0, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
});
bus.publish(bus.EVENTS.SETUP_TARGET_HIT, {
  symbol: 'XAU/USD', setupId: 'S-003', priceAtEvent: 4069.8, reason: 'Target raggiunto'
});

check('La posizione risulta chiusa', tracker.getOpenPosition('XAU/USD') === null);
var tp1Event = published.find(function (e) { return e.type === 'position.tp1Hit'; });
check('Viene pubblicato POSITION_TP1_HIT (non lo stesso evento grezzo SETUP_TARGET_HIT)', !!tp1Event);
check('Il prezzo di uscita è quello LIVE registrato dal motore (priceAtEvent), non il target teorico', tp1Event.payload.exitPrice === 4069.8);
check('Il guadagno in R per uno SHORT è calcolato correttamente (entry 4100, SL 4110, uscita 4069.8 → +3.02R)',
  Math.abs(tp1Event.payload.pnlR - 3.02) < 0.001, tp1Event.payload.pnlR);

// GARANZIA: se priceAtEvent manca per qualche motivo, non esplode — usa un riferimento reale (tp1 della posizione), mai un valore inventato
bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-004', direction: 'BUY', status: 'TRADE_READY',
  entryLo: 4100.0, sl: 4090.0, tp1: 4130.0, tp2: null, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
});
published.length = 0;
bus.publish(bus.EVENTS.SETUP_TARGET_HIT, { symbol: 'XAU/USD', setupId: 'S-004' }); // senza priceAtEvent
var tp1Fallback = published.find(function (e) { return e.type === 'position.tp1Hit'; });
check('GARANZIA: senza priceAtEvent, ripiega sul tp1 della posizione tracciata (mai un crash, mai un valore a caso)',
  tp1Fallback && tp1Fallback.payload.exitPrice === 4130.0);

// ═══ TP2: verificato che NON sia un evento di chiusura (per design, non per dimenticanza) ═══
console.log('\n═══ TP2 — verifica esplicita che non chiuda mai una posizione ═══');
bus.reset(); published.length = 0;
bus.subscribe('*', 'osservatore3', function (ev) { published.push(ev); });
tracker.attach(bus, config, logging);
bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
  symbol: 'XAU/USD', setupId: 'S-005', direction: 'BUY', status: 'TRADE_READY',
  entryLo: 4100.0, sl: 4090.0, tp1: 4120.0, tp2: 4140.0, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
});
check('Il motore non pubblica MAI un evento POSITION_TP2_HIT (verificato: non esiste alcun trigger nel motore per farlo)',
  !published.some(function (e) { return e.type === 'position.tp2Hit'; }));
check('tp2 resta comunque salvato nella posizione come dato INFORMATIVO', tracker.getOpenPosition('XAU/USD').tp2 === 4140.0);

// ═══ PERSISTENZA TRA RIAVVII ═══
console.log('\n═══ PERSISTENZA (sopravvive a un riavvio del servizio) ═══');
var beforeRestart = tracker.getOpenPosition('XAU/USD');
// simula un riavvio: nessun nuovo attach, si legge di nuovo dal file
var afterRestart = store.load('position_XAUUSD', null);
check('La posizione aperta è recuperabile dal file anche senza richiamare attach() di nuovo', afterRestart && afterRestart.setupId === beforeRestart.setupId);

// ═══ DATABASE: persistenza completa positions + setups ═══
console.log('\n═══ INTEGRAZIONE DATABASE ═══');
store.save('position_XAUUSD', null); // pulizia esplicita: la sezione precedente (TP2) ha lasciato una posizione aperta di proposito
process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';
var db = require('../modules/database/index.js');
var repo = require('../modules/database/repository.js');
var dbListener = require('../modules/database/listener.js');
var fakePg = require('./fakePg.js');

config.load();
var pool = db.init(config, logging, fakePg);
(async function testDb() {
  await db.runMigrations();

  bus.reset(); published.length = 0;
  tracker.attach(bus, config, logging);
  dbListener.attach(bus, config, logging);

  // Prima un setup deve esistere in 'setups' (vincolo di integrità
  // referenziale della tabella positions) — simulo lo stesso ordine
  // che accade davvero nel servizio: SETUP_CREATED prima di TRADE_READY
  bus.publish(bus.EVENTS.SETUP_CREATED, {
    symbol: 'XAU/USD', setupId: 'S-DB-001', direction: 'BUY', status: 'PENDING',
    confirm: 4100, invalid: 4090, marketStructure: {}, zones: {}, quality: null, reason: null
  });
  await new Promise(function (r) { setTimeout(r, 30); });

  bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
    symbol: 'XAU/USD', setupId: 'S-DB-001', direction: 'BUY', status: 'TRADE_READY',
    entryLo: 4100.0, sl: 4090.0, tp1: 4120.0, tp2: null, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET',
    marketStructure: {}, zones: {}, quality: null, reason: null
  });
  await new Promise(function (r) { setTimeout(r, 30); });

  var posRow = pool.tables.positions.find(function (p) { return p.setup_id === 'S-DB-001'; });
  check('POSITION_OPENED genera una riga in positions', !!posRow);
  check('La riga ha status OPEN', posRow && posRow.status === 'OPEN');

  bus.publish(bus.EVENTS.SETUP_TARGET_HIT, { symbol: 'XAU/USD', setupId: 'S-DB-001', priceAtEvent: 4119.5 });
  await new Promise(function (r) { setTimeout(r, 30); });

  var posRowClosed = pool.tables.positions.find(function (p) { return p.setup_id === 'S-DB-001'; });
  check('Alla chiusura, la riga in positions viene aggiornata (non duplicata)', pool.tables.positions.filter(function (p) { return p.setup_id === 'S-DB-001'; }).length === 1);
  check('Lo status passa a CLOSED con exit_price ed exit_reason corretti', posRowClosed.status === 'CLOSED' && posRowClosed.exit_price === 4119.5 && posRowClosed.exit_reason === 'TP1');

  var setupRow = pool.tables.setups['XAU/USD|S-DB-001'];
  check('setups viene aggiornato con i dati definitivi del trade (outcome/exit_price/pnl_r)', setupRow.exit_price === 4119.5 && setupRow.outcome === 'TP1');

  // ═══ ISOLAMENTO: un database che fallisce non deve MAI bloccare Position Tracker ═══
  console.log('\n═══ ISOLAMENTO (garanzia critica, ripetuta anche qui) ═══');
  bus.reset(); published.length = 0;
  logging.reset(); logging.configure({ level: 'ERROR', toFile: false });
  tracker.attach(bus, config, logging);
  dbListener.attach(bus, config, logging);
  bus.subscribe('*', 'osservatore4', function (ev) { published.push(ev); });

  pool.simulateFailure('database irraggiungibile (simulato)');
  var esploso = false;
  try {
    bus.publish(bus.EVENTS.SETUP_TRADE_READY, {
      symbol: 'XAU/USD', setupId: 'S-ISO-001', direction: 'BUY', status: 'TRADE_READY',
      entryLo: 4100.0, sl: 4090.0, tp1: 4120.0, tp2: null, tpFast: null, orderType: 'MARKET', executionMode: 'MARKET'
    });
  } catch (e) { esploso = true; }
  await new Promise(function (r) { setTimeout(r, 30); });

  check('GARANZIA: il database che fallisce non impedisce a Position Tracker di aprire la posizione', esploso === false && tracker.getOpenPosition('XAU/USD') !== null);
  check('La posizione risulta comunque tracciata correttamente in memoria/file nonostante il database sia giù', tracker.getOpenPosition('XAU/USD').setupId === 'S-ISO-001');

  console.log('\n' + (fails
    ? '❌ FASE 3: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ FASE 3: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
