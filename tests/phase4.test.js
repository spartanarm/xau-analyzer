// ══════════════════════════════════════════════════════════════════
// TEST FASE 4 — Telegram
//
// I tre punti più delicati da verificare, non solo a parole:
//   1. SICUREZZA: mai una risposta a un chat non autorizzato
//   2. "Setup invalidato" e "Stop Loss" non si sovrappongono mai
//   3. Il radar non spamma la stessa opportunità ogni ciclo

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

process.env.TWELVEDATA_API_KEY = 'test-key';
process.env.DATA_DIR = '/tmp/test-phase4-data';
var fs = require('fs');
try { fs.rmSync('/tmp/test-phase4-data', { recursive: true, force: true }); } catch (e) { }

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
var bus = require('../core/events/index.js');
var store = require('../modules/persistence/stateStore.js');
var telegram = require('../modules/telegram/index.js');
var positionTracker = require('../modules/positionTracker/index.js');

logging.configure({ level: 'ERROR', toFile: false });

// ── finto trasporto: registra ogni chiamata invece di contattare Telegram ──
function makeFakeTransport() {
  var calls = [];
  var fn = function (token, method, body) {
    calls.push({ method: method, body: body });
    if (method === 'sendMessage') return Promise.resolve({ ok: true, result: { message_id: calls.length } });
    if (method === 'getUpdates') return Promise.resolve({ ok: true, result: fn._nextUpdates || [] });
    return Promise.resolve({ ok: true, result: {} });
  };
  fn.calls = calls;
  fn.setNextUpdates = function (updates) { fn._nextUpdates = updates; };
  return fn;
}

function lastReply(transport) {
  var sendCalls = transport.calls.filter(function (c) { return c.method === 'sendMessage'; });
  return sendCalls[sendCalls.length - 1];
}

process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
process.env.TELEGRAM_CHAT_IDS = '111111';
config.load();

// ═══ SICUREZZA ═══
console.log('\n═══ SICUREZZA ═══');
var tg, transport;
var fakeStore = { load: store.load, save: store.save };
var fakeScheduler = { getStats: function () { return { uptimeMs: 0, cyclesRun: 0, cyclesSkipped: 0, cyclesFailed: 0, lastError: null }; } };
var fakeDatabase = { health: async function () { return { connected: false, reason: 'test' }; } };
var fakeRepo = { getRecentClosedPositions: async function () { return []; }, getPositionStats: async function () { return { trades: 0 }; } };

// ═══ Tutto il resto richiede await: eseguo in una IIFE async ═══
(async function run() {
  bus.reset();
  transport = makeFakeTransport();
  tg = telegram.attach(bus, config, logging, {
    store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transport
  });
  check('Si collega quando Telegram è configurato', tg !== false);

  transport.setNextUpdates([{ update_id: 1, message: { chat: { id: 999999 }, text: '/status' } }]);
  await tg.pollOnce();
  check('GARANZIA: un messaggio da un chat NON autorizzato non riceve NESSUNA risposta',
    transport.calls.filter(function (c) { return c.method === 'sendMessage'; }).length === 0);

  transport.calls.length = 0;
  transport.setNextUpdates([{ update_id: 2, message: { chat: { id: 111111 }, text: '/status' } }]);
  await tg.pollOnce();
  var statusReply = transport.calls.find(function (c) { return c.method === 'sendMessage'; });
  check('Un messaggio dal chat AUTORIZZATO riceve risposta', !!statusReply);
  check('/status include lo stato del servizio', statusReply.body.text.indexOf('Stato del servizio') !== -1);

  // ═══ NOTIFICHE DI BASE ═══
  console.log('\n═══ NOTIFICHE DI BASE ═══');
  bus.reset(); transport = makeFakeTransport();
  tg = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transport });

  bus.publish(bus.EVENTS.SETUP_CREATED, { symbol: 'XAU/USD', setupId: 'S-100', direction: 'BUY', reason: 'test' });
  check('SETUP_CREATED → notifica "Nuovo setup"', transport.calls.some(function (c) { return c.body.text.indexOf('Nuovo setup') !== -1; }));

  transport.calls.length = 0;
  bus.publish(bus.EVENTS.POSITION_OPENED, { symbol: 'XAU/USD', setupId: 'S-100', direction: 'BUY', entryPrice: 4100, sl: 4090, tp1: 4120, tp2: null });
  check('POSITION_OPENED → notifica "Trade attivato" con i numeri', transport.calls.some(function (c) { return c.body.text.indexOf('Trade attivato') !== -1 && c.body.text.indexOf('4100.00') !== -1; }));

  transport.calls.length = 0;
  bus.publish(bus.EVENTS.POSITION_TP1_HIT, { symbol: 'XAU/USD', setupId: 'S-100', exitPrice: 4120, pnlR: 2.0 });
  check('POSITION_TP1_HIT → notifica "TP1 raggiunto"', transport.calls.some(function (c) { return c.body.text.indexOf('TP1 raggiunto') !== -1; }));

  transport.calls.length = 0;
  bus.publish(bus.EVENTS.POSITION_SL_HIT, { symbol: 'XAU/USD', setupId: 'S-100', exitPrice: 4090, pnlR: -1.0 });
  check('POSITION_SL_HIT → notifica "Stop Loss"', transport.calls.some(function (c) { return c.body.text.indexOf('Stop Loss') !== -1; }));

  // ═══ IL PUNTO CRITICO: setup invalidato vs Stop Loss non si sovrappongono ═══
  console.log('\n═══ SETUP INVALIDATO vs STOP LOSS (mai due messaggi per la stessa chiusura) ═══');
  bus.reset(); transport = makeFakeTransport(); store.save('telegram_opened_setup_ids', []);
  tg = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transport });

  // Caso A: un setup che NON è mai stato aperto, poi invalidato
  bus.publish(bus.EVENTS.SETUP_INVALIDATED, { symbol: 'XAU/USD', setupId: 'S-201-MAI-APERTO', direction: 'SELL', reason: 'mai attivato' });
  check('Caso A: setup MAI aperto + invalidato → notifica "Setup invalidato"',
    transport.calls.some(function (c) { return c.body.text.indexOf('Setup invalidato') !== -1; }));

  // Caso B: un setup che VIENE aperto (POSITION_OPENED), poi il motore lo invalida (equivalente SL)
  transport.calls.length = 0;
  bus.publish(bus.EVENTS.POSITION_OPENED, { symbol: 'XAU/USD', setupId: 'S-202-APERTO', direction: 'BUY', entryPrice: 4100, sl: 4090, tp1: 4120 });
  transport.calls.length = 0; // scarto la notifica di apertura, mi serve solo il momento della chiusura
  bus.publish(bus.EVENTS.SETUP_INVALIDATED, { symbol: 'XAU/USD', setupId: 'S-202-APERTO', direction: 'BUY', reason: 'chiusura oltre invalidazione' });
  check('GARANZIA CRITICA: setup GIÀ aperto + invalidato → NESSUN "Setup invalidato" duplicato',
    !transport.calls.some(function (c) { return c.body.text.indexOf('Setup invalidato') !== -1; }));

  // ═══ RADAR: deduplica per id, mai la stessa notifica due volte ═══
  console.log('\n═══ RADAR — deduplica ═══');
  bus.reset(); transport = makeFakeTransport(); store.save('telegram_radar_notified', []);
  tg = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transport });

  var opp = { id: 'O-abc123', dir: 'LONG', setupType: 'BREAKOUT + RETEST', trigger: 'Chiusura M15 sopra 4120' };
  bus.publish(bus.EVENTS.RADAR_OPPORTUNITY, { symbol: 'XAU/USD', opportunities: [opp] });
  check('Prima comparsa di un\'opportunità → notifica inviata', transport.calls.length === 1);

  transport.calls.length = 0;
  // stesso identico id, ripubblicato (come farebbe l'orchestratore ogni
  // ciclo finché l'opportunità resta attiva) — non deve renotificare
  bus.publish(bus.EVENTS.RADAR_OPPORTUNITY, { symbol: 'XAU/USD', opportunities: [opp] });
  check('GARANZIA: la STESSA opportunità (stesso id) non viene renotificata ad ogni ciclo', transport.calls.length === 0);

  transport.calls.length = 0;
  var opp2 = { id: 'O-def456', dir: 'SHORT', setupType: 'PULLBACK', trigger: 'test' };
  bus.publish(bus.EVENTS.RADAR_OPPORTUNITY, { symbol: 'XAU/USD', opportunities: [opp, opp2] });
  check('Una NUOVA opportunità (id diverso) tra quelle attive genera una notifica', transport.calls.length === 1);
  check('La notifica è per la nuova opportunità (PULLBACK), non un duplicato della prima', transport.calls[0].body.text.indexOf('PULLBACK') !== -1);

  // ═══ COMANDI ═══
  console.log('\n═══ COMANDI ═══');
  store.save('latest_snapshot', {
    symbol: 'XAU/USD', generatedAt: Date.now(), price: 4108.5, bias: { bias: 'BULLISH' },
    atr: { h1: 6.2, m15: 2.1 },
    plan: { status: 'TRADE_READY', executionMode: 'MARKET', direction: 'BUY', orderType: 'MARKET', entryLo: 4108.5, entryHi: null, sl: 4098, tp1: 4130, tp2: null, quality: { grade: 'A', confidence: 70 }, reason: 'ok' }
  });
  bus.reset(); transport = makeFakeTransport();
  tg = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transport });

  transport.setNextUpdates([{ update_id: 10, message: { chat: { id: 111111 }, text: '/market' } }]);
  await tg.pollOnce();
  check('/market risponde con prezzo e bias', lastReply(transport).body.text.indexOf('4108.5') !== -1 && lastReply(transport).body.text.indexOf('BULLISH') !== -1);

  transport.calls.length = 0;
  transport.setNextUpdates([{ update_id: 11, message: { chat: { id: 111111 }, text: '/setup' } }]);
  await tg.pollOnce();
  check('/setup risponde con entry/SL/TP del piano corrente', lastReply(transport).body.text.indexOf('4098') !== -1 && lastReply(transport).body.text.indexOf('4130') !== -1);

  transport.calls.length = 0;
  transport.setNextUpdates([{ update_id: 12, message: { chat: { id: 111111 }, text: '/help' } }]);
  await tg.pollOnce();
  check('/help elenca tutti i comandi', ['/status', '/market', '/setup', '/open', '/history', '/stats'].every(function (c) { return lastReply(transport).body.text.indexOf(c) !== -1; }));

  transport.calls.length = 0;
  transport.setNextUpdates([{ update_id: 13, message: { chat: { id: 111111 }, text: '/news' } }]);
  await tg.pollOnce();
  check('/news dichiara onestamente che il modulo non è ancora attivo', lastReply(transport).body.text.indexOf('non è ancora attivo') !== -1);

  // /history e /stats con database disabilitato (fakeDatabase/fakeConfig di default hanno database.enabled=false)
  transport.calls.length = 0;
  transport.setNextUpdates([{ update_id: 14, message: { chat: { id: 111111 }, text: '/stats' } }]);
  await tg.pollOnce();
  check('/stats senza database collegato risponde chiaramente (non un errore criptico)', lastReply(transport).body.text.indexOf('non è collegato') !== -1 || lastReply(transport).body.text.indexOf('Ancora nessun trade') !== -1);

  // ═══ ISOLAMENTO: un invio Telegram che fallisce non deve rompere l'Event Bus ═══
  console.log('\n═══ ISOLAMENTO (garanzia critica) ═══');
  bus.reset();
  var transportRotto = function () { return Promise.reject(new Error('Telegram irraggiungibile (simulato)')); };
  var altriEventiRicevuti = [];
  bus.subscribe(bus.EVENTS.SETUP_CREATED, 'altro-consumatore', function () { altriEventiRicevuti.push('ok'); });
  logging.reset(); logging.configure({ level: 'ERROR', toFile: false });
  tg = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker, transport: transportRotto });

  var esploso = false;
  try { bus.publish(bus.EVENTS.SETUP_CREATED, { symbol: 'XAU/USD', setupId: 'S-ISO', direction: 'BUY', reason: 'x' }); }
  catch (e) { esploso = true; }
  await new Promise(function (r) { setTimeout(r, 30); });

  check('GARANZIA: un invio Telegram fallito non fa esplodere publish()', esploso === false);
  check('GARANZIA: gli altri consumatori ricevono comunque l\'evento', altriEventiRicevuti.length === 1);

  // ═══ BACKOFF SU ERRORE (bug reale trovato e corretto: senza questo,
  // un problema di rete persistente farebbe ripetere getUpdates a
  // raffica, martellando l'API di Telegram e riempiendo i log) ═══
  console.log('\n═══ BACKOFF SU ERRORE DI RETE ═══');
  bus.reset();
  var transportSempreRotto = function () { return Promise.reject(new Error('rete assente (simulato)')); };
  var tgBackoff = telegram.attach(bus, config, logging, {
    store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker,
    transport: transportSempreRotto, pollErrorBackoffMs: 40
  });
  var t0 = Date.now();
  await tgBackoff.pollOnce();
  var elapsed = Date.now() - t0;
  check('GARANZIA: dopo un errore di getUpdates, pollOnce attende il backoff prima di tornare (mai un ciclo istantaneo)', elapsed >= 35, elapsed + 'ms');

  // ═══ DISABILITATO DI DEFAULT ═══
  console.log('\n═══ DISABILITATO (sicurezza di default) ═══');
  var cfgSenzaToken = config.load({ skipEnv: true }); // senza TELEGRAM_BOT_TOKEN → telegram.enabled resta false
  bus.reset();
  var tg2 = telegram.attach(bus, config, logging, { store: fakeStore, scheduler: fakeScheduler, database: fakeDatabase, repo: fakeRepo, positionTracker: positionTracker });
  check('Senza token configurato, Telegram non si attiva', tg2 === false);
  check('Nessun consumatore registrato sull\'Event Bus', Object.keys(bus.listSubscribers()).length === 0);

  console.log('\n' + (fails
    ? '❌ FASE 4: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ FASE 4: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
