// ══════════════════════════════════════════════════════════════════
// TEST FASE 1 — Config Engine, Event Bus, Logger
// Attenzione particolare alle GARANZIE, non solo al funzionamento:
//   · la config non può essere alterata da un modulo
//   · un consumatore in errore non rompe gli altri né il produttore
//   · il logger non fa mai fallire chi lo chiama

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

// ═══ CONFIG ENGINE ═══
console.log('\n═══ CONFIG ENGINE ═══');
process.env.TWELVEDATA_API_KEY = 'chiave-di-test';
process.env.DATA_DIR = '/tmp/test-phase1';

var config = require('../core/config/index.js');
var cfg = config.load();

check('Carica senza errori di validazione', config.errors().length === 0, config.errors().join('; '));
check('Legge la chiave API dalla variabile d\'ambiente', cfg.marketData.apiKey === 'chiave-di-test');
check('Legge il percorso dati dalla variabile d\'ambiente', cfg.paths.dataDir === '/tmp/test-phase1');
check('Parametri analisi per strumento presenti', cfg.instruments['XAU/USD'].analysis.swingK === 2);
check('Espone i parametri interni del motore in sola lettura', cfg.engineOwned.setupRules.slBufferAtr === 0.2);
check('Marca esplicitamente i parametri del motore come non modificabili', cfg.engineOwned._readOnly === true);

// GARANZIA: immutabilità
cfg.instruments['XAU/USD'].analysis.swingK = 999;
check('GARANZIA: un modulo NON può alterare la config condivisa', cfg.instruments['XAU/USD'].analysis.swingK === 2);
cfg.marketData.rateLimitPerMin = 99;
check('GARANZIA: nemmeno i parametri di rete sono alterabili', cfg.marketData.rateLimitPerMin === 7);

// Validazione: deve FALLIRE quando serve
var cfgNoKey = config.load({ skipEnv: true });
check('Validazione: segnala la chiave API mancante', config.errors().some(function (e) { return /apiKey/.test(e); }));

var cfgBadTelegram = config.load({ skipEnv: true, overrides: { telegram: { enabled: true, botToken: 'x', allowedChatIds: [] } } });
check('Validazione: blocca Telegram senza lista chat autorizzate (bot aperto a chiunque)',
  config.errors().some(function (e) { return /allowedChatIds/.test(e); }));

var cfgBadRate = config.load({ skipEnv: true, overrides: { marketData: { rateLimitPerMin: 50 } } });
check('Validazione: rifiuta un rate limit oltre il limite reale del fornitore',
  config.errors().some(function (e) { return /rateLimitPerMin/.test(e); }));

// describe(): vista unica, segreti mascherati
config.load(); // ricarica con env
var described = config.describe();
var apiKeyRow = described.find(function (r) { return r.key === 'marketData.apiKey'; });
check('Vista unificata dei parametri disponibile', described.length > 20, described.length + ' parametri');
check('I segreti NON compaiono in chiaro nella vista unificata', apiKeyRow && apiKeyRow.value === '***');

// ═══ EVENT BUS ═══
console.log('\n═══ EVENT BUS ═══');
var bus = require('../core/events/index.js');
bus.reset();

var received = [];
bus.subscribe(bus.EVENTS.SETUP_CREATED, 'consumatore-test', function (ev) { received.push(ev); });
bus.publish(bus.EVENTS.SETUP_CREATED, { setupId: 'S-123' });
check('Un evento pubblicato raggiunge il consumatore iscritto', received.length === 1 && received[0].payload.setupId === 'S-123');

var wildcard = [];
bus.subscribe('*', 'osservatore-globale', function (ev) { wildcard.push(ev.type); });
bus.publish(bus.EVENTS.CYCLE_COMPLETED, {});
bus.publish(bus.EVENTS.SETUP_INVALIDATED, {});
check('Un consumatore "*" riceve tutti i tipi di evento', wildcard.length === 2);

// GARANZIA CRITICA: isolamento
bus.reset();
var ordine = [];
var erroriRegistrati = [];
bus.setErrorReporter(function (info) { erroriRegistrati.push(info.handler); });
bus.subscribe(bus.EVENTS.SETUP_TRADE_READY, 'telegram-che-fallisce', function () { ordine.push('telegram-tentato'); throw new Error('Telegram non raggiungibile'); });
bus.subscribe(bus.EVENTS.SETUP_TRADE_READY, 'database', function () { ordine.push('database-ok'); });

var esploso = false;
try { bus.publish(bus.EVENTS.SETUP_TRADE_READY, {}); } catch (e) { esploso = true; }

check('GARANZIA: il produttore non vede l\'errore del consumatore', esploso === false);
check('GARANZIA: un consumatore in errore NON impedisce agli altri di ricevere', ordine.indexOf('database-ok') !== -1, ordine.join(' → '));
check('L\'errore del consumatore viene comunque registrato (non ingoiato in silenzio)', erroriRegistrati.indexOf('telegram-che-fallisce') !== -1);

// isolamento anche per consumatori asincroni
bus.reset();
var asyncErrori = [];
bus.setErrorReporter(function (info) { asyncErrori.push(info.handler); });
bus.subscribe(bus.EVENTS.POSITION_SL_HIT, 'consumatore-async-rotto', function () { return Promise.reject(new Error('errore asincrono')); });
var esplosoAsync = false;
try { bus.publish(bus.EVENTS.POSITION_SL_HIT, {}); } catch (e) { esplosoAsync = true; }
check('GARANZIA: anche un consumatore asincrono in errore non rompe il produttore', esplosoAsync === false);

// cronologia e introspezione
bus.reset();
bus.subscribe(bus.EVENTS.CYCLE_COMPLETED, 'x', function () { });
bus.publish(bus.EVENTS.CYCLE_COMPLETED, { n: 1 });
bus.publish(bus.EVENTS.CYCLE_COMPLETED, { n: 2 });
check('Mantiene la cronologia degli eventi per la diagnosi', bus.getHistory().length === 2);
check('Permette di sapere chi è iscritto a cosa', bus.listSubscribers()[bus.EVENTS.CYCLE_COMPLETED][0] === 'x');
check('Tutti i tipi di evento sono dichiarati come costanti (nessuna stringa sparsa)', Object.keys(bus.EVENTS).length >= 25, Object.keys(bus.EVENTS).length + ' tipi');

// ═══ LOGGER ═══
console.log('\n═══ LOGGER ═══');
var fs = require('fs');
var logger = require('../core/logging/index.js');
var logDir = '/tmp/test-phase1-logs';
try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (e) { }

logger.configure({ level: 'INFO', toFile: true, dir: logDir });
var log = logger.forComponent('test-modulo');
log.info('evento.test', 'messaggio di prova', { chiave: 'valore' });

check('Crea la cartella dei log', fs.existsSync(logDir));
var logContent = fs.readFileSync(logDir + '/app.log', 'utf8');
var parsed = JSON.parse(logContent.trim().split('\n')[0]);
check('Scrive log strutturati in JSON (non testo libero)', parsed.level === 'INFO' && parsed.component === 'test-modulo');
check('Il log include il tipo di evento e il contesto', parsed.event === 'evento.test' && parsed.context.chiave === 'valore');

// livelli
logger.reset();
logger.configure({ level: 'WARN', toFile: false, dir: logDir });
var log2 = logger.forComponent('test-livelli');
var infoRecord = log2.info('x', 'questo non deve passare');
var warnRecord = log2.warn('y', 'questo sì');
check('Rispetta il livello configurato: INFO scartato quando il livello è WARN', infoRecord === null);
check('Rispetta il livello configurato: WARN passa', warnRecord !== null);

// GARANZIA: il logger non rompe mai il chiamante
logger.reset();
logger.configure({ level: 'INFO', toFile: true, dir: '/percorso/che/non/esiste/e/non/si/puo/creare' });
var log3 = logger.forComponent('test-resilienza');
var esplosoLog = false;
try { log3.info('x', 'messaggio con destinazione impossibile'); } catch (e) { esplosoLog = true; }
check('GARANZIA: un problema di scrittura NON fa fallire chi chiama il logger', esplosoLog === false);

// ring buffer per la dashboard
logger.reset();
logger.configure({ level: 'INFO', toFile: false });
var log4 = logger.forComponent('test-ring');
log4.info('a', 'uno'); log4.warn('b', 'due'); log4.error('c', 'tre');
check('Mantiene in memoria i log recenti per la dashboard', logger.recent().length === 3);
check('Distingue i livelli nei log recenti', logger.recent().filter(function (r) { return r.level === 'ERROR'; }).length === 1);

// ═══ INTEGRAZIONE: i tre componenti insieme ═══
console.log('\n═══ INTEGRAZIONE ═══');
bus.reset();
logger.reset();
logger.configure({ level: 'INFO', toFile: false });
var logIntegr = logger.forComponent('event-bus');
bus.setErrorReporter(function (info) { logIntegr.error('consumer.failed', info.message, { handler: info.handler }); });
bus.subscribe(bus.EVENTS.SERVICE_ERROR, 'rotto', function () { throw new Error('guasto simulato'); });
bus.publish(bus.EVENTS.SERVICE_ERROR, {});
var errorLogged = logger.recent().some(function (r) { return r.level === 'ERROR' && r.event === 'consumer.failed'; });
check('Gli errori dei consumatori finiscono nel sistema di log strutturato', errorLogged);

console.log('\n' + (fails
  ? '❌ FASE 1: ' + fails + '/' + total + ' TEST FALLITI'
  : '✅ FASE 1: TUTTI I ' + total + ' TEST SUPERATI'));
process.exit(fails ? 1 : 0);
