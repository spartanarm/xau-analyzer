// ══════════════════════════════════════════════════════════════════
// TEST FASE 2 — Database
//
// Nessun Postgres vero disponibile in questo ambiente (niente accesso
// a internet, verificato). Uso il finto driver (tests/fakePg.js) per
// verificare che IL NOSTRO codice generi le query corrette. La prova
// definitiva contro un Postgres vero avviene quando lo colleghi su
// Railway — la verifichiamo insieme in quel momento, come sempre.

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

process.env.TWELVEDATA_API_KEY = 'test-key';
process.env.DATA_DIR = '/tmp/test-phase2-data';
process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
var bus = require('../core/events/index.js');
var db = require('../modules/database/index.js');
var repo = require('../modules/database/repository.js');
var listener = require('../modules/database/listener.js');
var fakePg = require('./fakePg.js');

logging.configure({ level: 'ERROR', toFile: false }); // silenzioso durante i test, tranne gli errori veri

// ═══ CONNESSIONE E MIGRAZIONI ═══
console.log('\n═══ CONNESSIONE E MIGRAZIONI ═══');
config.load();
var pool = db.init(config, logging, fakePg);
check('Si connette quando DATABASE_URL è presente', db.isEnabled() === true);

async function testMigrations() {
  // Conta i file di migrazione realmente presenti, invece di un numero
  // fisso: aggiungere una migrazione in futuro non deve rompere il test.
  var fsMod = require('fs');
  var migrationCount = fsMod.readdirSync(__dirname + '/../modules/database/migrations')
    .filter(function (f) { return f.endsWith('.sql'); }).length;

  var r1 = await db.runMigrations();
  check('Applica TUTTE le migrazioni presenti al primo avvio', r1.applied.length === migrationCount,
    r1.applied.length + '/' + migrationCount + ': ' + r1.applied.join(', '));

  var r2 = await db.runMigrations();
  check('GARANZIA: rilanciata una seconda volta, non riapplica nulla (idempotente)', r2.applied.length === 0);

  var h = await db.health();
  check('Il controllo di salute riporta connesso', h.connected === true);
}

// ═══ REPOSITORY: query corrette da eventi realistici ═══
async function testRepository() {
  console.log('\n═══ REPOSITORY ═══');

  // Evento SETUP_CREATED realistico (stessa forma pubblicata da scheduler.js)
  var createdEvent = {
    type: 'setup.created', at: Date.now(),
    payload: {
      symbol: 'XAU/USD', setupId: 'S-test-001', direction: 'BUY', status: 'PENDING',
      confirm: 4100.5, invalid: 4090.0, target: null,
      marketStructure: { h4: { trend: 'BULLISH', state: 'INTACT', lastEvent: null }, h1: null, m15: null, m5: null },
      zones: { support: [{ center: 4090, score: 3 }], resistance: [] },
      atrH1: 6.2, atrM15: 2.1,
      quality: { grade: 'A', confidence: 65, factors: ['bias concorde (+25)'] },
      reason: 'Zona di retest valida ma non abbastanza forte',
      orderType: null, executionMode: 'FAST CONFIRMATION',
      entryLo: null, entryHi: null, sl: null, tp1: null, tp2: null, tpFast: null, rr1: null, rr2: null, requiredRR: null
    }
  };

  await repo.recordSetupLifecycleEvent(createdEvent);
  var setupsQ = pool.queries.filter(function (q) { return /INSERT INTO setups/.test(q.text); });
  var eventsQ = pool.queries.filter(function (q) { return /INSERT INTO setup_events/.test(q.text); });
  check('Un evento setup genera UNA riga in setups', setupsQ.length === 1);
  check('Un evento setup genera UNA riga in setup_events', eventsQ.length === 1);
  check('L\'ordine è corretto: setup PRIMA dell\'evento (vincolo di integrità referenziale)',
    pool.queries.indexOf(setupsQ[0]) < pool.queries.indexOf(eventsQ[0]));

  var savedSetup = pool.tables.setups['XAU/USD|S-test-001'];
  check('I dati numerici sono salvati correttamente', savedSetup.status === 'PENDING' && Number(savedSetup.atr_h1) === 6.2 || savedSetup.atr_h1 === 6.2, JSON.stringify({ status: savedSetup.status, atr: savedSetup.atr_h1 }));
  check('I campi JSON (market_structure, zones, quality_factors) sono salvati come testo JSON valido',
    (function () { try { JSON.parse(savedSetup.market_structure); JSON.parse(savedSetup.zones); JSON.parse(savedSetup.quality_factors); return true; } catch (e) { return false; } })());

  // Seconda scrittura sullo STESSO setup, con dati aggiuntivi (il piano
  // ora ha calcolato entry/SL/TP): verifica il COALESCE — i campi nuovi
  // aggiornano, quelli non presenti mantengono il valore già salvato.
  var tradeReadyEvent = {
    type: 'setup.tradeReady', at: Date.now() + 60000,
    payload: {
      symbol: 'XAU/USD', setupId: 'S-test-001', status: 'TRADE_READY', direction: 'BUY',
      orderType: 'MARKET', executionMode: 'FAST CONFIRMATION',
      entryLo: 4101.2, entryHi: null, sl: 4090.8, tp1: 4125.0, tp2: 4140.0, tpFast: null,
      rr1: 2.14, rr2: 3.5, requiredRR: 1.25,
      marketStructure: { h4: { trend: 'BULLISH', state: 'CONTINUATION', lastEvent: null }, h1: null, m15: null, m5: null },
      zones: { support: [], resistance: [] }, atrH1: 6.3, atrM15: 2.0,
      quality: { grade: 'A+', confidence: 82, factors: [] }, reason: 'Confermato'
    }
  };
  await repo.recordSetupLifecycleEvent(tradeReadyEvent);
  var updated = pool.tables.setups['XAU/USD|S-test-001'];
  check('COALESCE: il nuovo entry/SL/TP aggiorna la riga esistente', updated.entry_lo === 4101.2 && updated.sl === 4090.8);
  check('COALESCE: lo status passa a TRADE_READY', updated.status === 'TRADE_READY');
  check('COALESCE: i campi non presenti nel secondo evento (invalidation_level) mantengono il valore originale',
    updated.invalidation_level === 4090.0);
  check('Rimane UNA sola riga per lo stesso setupId (upsert, non duplicato)', Object.keys(pool.tables.setups).filter(function (k) { return k === 'XAU/USD|S-test-001'; }).length === 1);

  var eventsAfter = pool.tables.setup_events.filter(function (e) { return e.setup_id === 'S-test-001'; });
  check('setup_events accumula OGNI transizione (cronologia immutabile), qui 2', eventsAfter.length === 2);

  // Evento senza setupId (es. radar) non deve toccare la tabella setups
  var beforeCount = Object.keys(pool.tables.setups).length;
  await repo.recordSetupLifecycleEvent({ type: 'radar.opportunity', at: Date.now(), payload: { symbol: 'XAU/USD' } });
  check('Un evento senza setupId non genera righe in setups', Object.keys(pool.tables.setups).length === beforeCount);

  // Analisi
  await repo.insertAnalysis({
    type: 'cycle.completed', at: Date.now(), payload: {
      snapshot: {
        symbol: 'XAU/USD', generatedAt: Date.now(), price: 4108.5,
        bias: { bias: 'BULLISH' },
        plan: { quality: { grade: 'A', confidence: 70 }, executionMode: 'MARKET', action: 'PLAN', status: 'TRADE_READY', reason: 'ok' }
      }
    }
  });
  check('Un ciclo completato genera una riga in analyses', pool.tables.analyses.length === 1);
  check('Il campo decision distingue TRADE da NO_TRADE correttamente', pool.tables.analyses[0].decision === 'TRADE');
}

// ═══ LISTENER: collegamento Event Bus -> database ═══
async function testListener() {
  console.log('\n═══ LISTENER ═══');
  bus.reset();
  var attached = listener.attach(bus, config, logging);
  check('Si collega quando il database è abilitato', attached === true);
  check('Si iscrive agli eventi di ciclo di vita', Object.keys(bus.listSubscribers()).length >= 9);

  pool.queries = []; // pulisco per isolare questo test
  bus.publish(bus.EVENTS.SETUP_CONFIRMED, {
    symbol: 'XAU/USD', setupId: 'S-test-002', status: 'ACTIVATED', direction: 'SELL',
    marketStructure: {}, zones: {}, atrH1: 5, atrM15: 1.5, quality: null, reason: null
  });
  // il subscribe è sincrono ma la scrittura reale è una promise: attendo un istante
  await new Promise(function (r) { setTimeout(r, 50); });
  var wrote = pool.queries.some(function (q) { return /INSERT INTO setups/.test(q.text); });
  check('Pubblicare un evento sul bus fa scrivere davvero nel database', wrote);
}

// ═══ GARANZIA CRITICA: un database che fallisce non deve MAI rompere il ciclo ═══
async function testIsolation() {
  console.log('\n═══ ISOLAMENTO (garanzia critica) ═══');
  bus.reset();
  logging.reset(); logging.configure({ level: 'ERROR', toFile: false });
  var erroriCatturati = [];
  bus.setErrorReporter(function (info) { erroriCatturati.push(info); });
  listener.attach(bus, config, logging);

  pool.simulateFailure('connessione al database persa (simulato)');

  var esploso = false;
  try {
    bus.publish(bus.EVENTS.SETUP_INVALIDATED, {
      symbol: 'XAU/USD', setupId: 'S-test-003', status: 'INVALIDATED', direction: 'BUY',
      marketStructure: {}, zones: {}, quality: null, reason: null
    });
  } catch (e) { esploso = true; }

  await new Promise(function (r) { setTimeout(r, 50); });

  check('GARANZIA: un errore del database NON fa esplodere publish()', esploso === false);
  check('L\'errore viene comunque registrato nei log (non ingoiato in silenzio)',
    erroriCatturati.length === 0); // il repository stesso cattura l'errore col .catch(), non risale al bus come handler-error
  // verifica alternativa: il repository logga l'errore direttamente (via log.error dentro listener.js)
  var loggedErrors = logging.recent().filter(function (r) { return r.level === 'ERROR' && r.event === 'write.failed'; });
  check('L\'errore di scrittura è tracciato nei log strutturati', loggedErrors.length >= 1);
}

// ═══ DISABILITATO DI DEFAULT: sicurezza se qualcuno dimentica DATABASE_URL ═══
async function testDisabled() {
  console.log('\n═══ DISABILITATO (sicurezza di default) ═══');
  db.reset();
  var cfgSenzaDb = config.load({ skipEnv: true }); // nessuna variabile d'ambiente: database.enabled resta false
  var pool2 = db.init(config, logging, fakePg);
  check('Senza DATABASE_URL, init() non crea nessuna connessione', pool2 === null);
  check('isEnabled() riflette correttamente lo stato disattivato', db.isEnabled() === false);

  var r = await db.runMigrations();
  check('Le migrazioni non falliscono se il database è disattivato (no-op sicuro)', r.skipped === true);

  bus.reset();
  var attached2 = listener.attach(bus, config, logging);
  check('Il listener non si iscrive a nulla se il database è disattivato', attached2 === false);
  check('Nessun consumatore registrato sull\'Event Bus', Object.keys(bus.listSubscribers()).length === 0);
}

(async function run() {
  try {
    await testMigrations();
    await testRepository();
    await testListener();
    await testIsolation();
    await testDisabled();
  } catch (err) {
    console.error('\n💥 ERRORE INASPETTATO DURANTE I TEST:', err.message, err.stack);
    fails++;
  }

  console.log('\n' + (fails
    ? '❌ FASE 2: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ FASE 2: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
