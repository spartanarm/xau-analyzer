// ══════════════════════════════════════════════════════════════════
// SCHEDULER — il cuore del servizio H24. Ogni N minuti:
//   1. scarica le candele più recenti (dataFetcher.js)
//   2. richiama engine.js (il motore, INTOCCATO — stessa identica
//      logica di index.html, verificata con 246 controlli automatici)
//   3. fa avanzare il tracker/radar/stability persistiti su disco
//   4. salva il piano risultante, pronto per essere letto dalla pagina
//
// Riusa VERBATIM la stessa logica di orchestrazione già scritta e
// testata in replay_engine.js (buildAnalysisFrame) — non la reinventa:
// è lo stesso identico modo in cui il motore viene fatto girare da mesi
// nei test, solo ora su un timer invece che su un dataset storico.

var E = require('./engine.js');
var store = require('./stateStore.js');

var CFG = { swingK: 2, zoneTolPct: 0.12, eqTolPct: 0.05, atrPeriod: 14, minRR: 1.5,
  swingAtrMult: 0.5, brokerOffset: 0, rrAplus: 1.25, rrA: 1.25, rrB: 1.5,
  alertsSound: true };

var RUN_EVERY_MS = 5 * 60 * 1000; // ogni 5 minuti, come richiesto

// ── Stessa identica funzione già verificata su 246 test in
// replay_engine.js — riportata qui parola per parola, non riscritta,
// perché deve restare l'unico modo in cui candele grezze diventano
// bias/struttura/zone in tutto il progetto (stesso principio "un solo
// motore, mai due calcoli paralleli" applicato in ogni turno precedente).
function buildAnalysisFrame(candlesAtT, price, refTs) {
  var kMap = { h4: CFG.swingK, h1: CFG.swingK + 1, m15: CFG.swingK + 1, m5: CFG.swingK + 2 };
  var tf = {};
  ['h4', 'h1', 'm15', 'm5'].forEach(function (k) {
    tf[k] = candlesAtT[k] && candlesAtT[k].length ? E.buildTF(candlesAtT[k], CFG, kMap[k]) : { ok: false };
  });
  var atrH1 = tf.h1.ok ? tf.h1.vol.atr : null;
  var pts = [];
  if (tf.h4.ok) tf.h4.swings.slice(-14).forEach(function (s) { pts.push({ price: s.price, weight: 3, label: 'H4' }); });
  if (tf.h1.ok) tf.h1.swings.slice(-18).forEach(function (s) { pts.push({ price: s.price, weight: 2, label: 'H1' }); });
  if (tf.h1.ok) {
    var cd = tf.h1.candles;
    var todayStart = new Date(refTs); todayStart.setUTCHours(0, 0, 0, 0);
    var today = cd.filter(function (c) { return c.t >= todayStart.getTime(); });
    if (today.length) {
      pts.push({ price: Math.max.apply(null, today.map(function (c) { return c.h; })), weight: 2, label: 'DAY-H' });
      pts.push({ price: Math.min.apply(null, today.map(function (c) { return c.l; })), weight: 2, label: 'DAY-L' });
    }
    var sess = cd.slice(-12);
    pts.push({ price: Math.max.apply(null, sess.map(function (c) { return c.h; })), weight: 1, label: 'SESS-H' });
    pts.push({ price: Math.min.apply(null, sess.map(function (c) { return c.l; })), weight: 1, label: 'SESS-L' });
  }
  var zones = price !== null ? E.clusterZones(pts, CFG.zoneTolPct, price) : [];
  var res = zones.filter(function (z) { return z.low > price; }).sort(function (a, b) { return a.center - b.center; }).slice(0, 3);
  var sup = zones.filter(function (z) { return z.high < price; }).sort(function (a, b) { return b.center - a.center; }).slice(0, 3);
  var bias = E.combineBias(tf);
  var setup = E.buildSetup(bias.bias, tf, price, res, sup, atrH1);
  return { tf: tf, price: price, res: res, sup: sup, bias: bias, setup: setup, atrH1: atrH1 };
}

function lastClosedCandle(cd, tfMs) {
  if (!cd || !cd.length) return null;
  var now = Date.now();
  for (var i = cd.length - 1; i >= 0; i--) { if (cd[i].t + tfMs <= now) return { c: cd[i].c, h: cd[i].h, l: cd[i].l, t: cd[i].t }; }
  return null;
}

async function runCycle(apiKey) {
  var fetcher = require('./dataFetcher.js');
  var candlesMap;
  try {
    candlesMap = await fetcher.fetchAllTimeframes(apiKey);
  } catch (e) {
    console.error('[scheduler] fetch fallito, ciclo saltato:', e.message);
    return;
  }

  var m5 = candlesMap.m5;
  var price = m5 && m5.length ? m5[m5.length - 1].c : null;
  var now = Date.now();

  var core = buildAnalysisFrame(candlesMap, price, now);

  // ── Stato persistito: stesso ruolo di localStorage nel browser, ora su file ──
  var tracker = store.load('setup_v1', null);
  var stability = store.load('stab_v1', []);
  var radar = store.load('radar_v1', []);
  var lastTerminal = store.load('lastterm_v1', null);

  var m15Closed = core.tf.m15.ok ? lastClosedCandle(core.tf.m15.candles, 15 * 60 * 1000) : null;
  var m5Dir = core.tf.m5.ok ? (core.tf.m5.structure.trend === 'BULLISH' ? 1 : core.tf.m5.structure.trend === 'BEARISH' ? -1 : 0) : null;

  tracker = E.advanceSetup(tracker, core.setup, { now: now, price: price, m15Closed: m15Closed, m5Dir: m5Dir, atrH1: core.atrH1 });

  var techCtx = {
    sup: core.sup, res: core.res,
    m15: core.tf.m15.ok ? core.tf.m15.structure : null, h1: core.tf.h1.ok ? core.tf.h1.structure : null,
    atrM15: core.tf.m15.ok ? core.tf.m15.vol.atr : null, atrM5: core.tf.m5.ok ? core.tf.m5.vol.atr : null,
    m15Closed: m15Closed, m5Dir: m5Dir,
    m5Closed: core.tf.m5.ok ? lastClosedCandle(core.tf.m5.candles, 5 * 60 * 1000) : null,
    now: now, lastTerminal: lastTerminal, stability: stability,
    rrThresholds: { aplus: CFG.rrAplus, a: CFG.rrA, b: CFG.rrB }
  };

  var plan = E.buildTradePlan(tracker, core.bias, price, core.atrH1, CFG.minRR, techCtx);
  tracker = plan.tracker || tracker;

  // radar: opportunità future quando non c'è un piano operativo
  radar = E.buildOpportunityRadar(radar, {
    price: price, atrH1: core.atrH1, atrExec: techCtx.atrM15, bias: core.bias.bias,
    sup: core.sup, res: core.res, m15: techCtx.m15, h1: techCtx.h1,
    m15Closed: techCtx.m15Closed, m5Bar: techCtx.m5Closed, now: now,
    tracker: tracker, thr: techCtx.rrThresholds, minRR: CFG.minRR
  });
  plan.radar = radar;

  store.save('setup_v1', tracker);
  store.save('stab_v1', stability);
  store.save('radar_v1', radar);

  // ── Snapshot completo: quello che la pagina web leggerà ──
  var snapshot = {
    generatedAt: now,
    price: price,
    priceTime: m5 && m5.length ? m5[m5.length - 1].t : null,
    bias: core.bias,
    plan: plan,
    radar: radar
  };
  store.save('latest_snapshot', snapshot);

  console.log('[' + new Date(now).toISOString() + '] ciclo completato — prezzo ' + (price ? price.toFixed(2) : 'n.d.') +
    ' — piano: ' + plan.action + '/' + plan.status);
}

function start(apiKey) {
  console.log('Scheduler avviato — un ciclo ogni ' + (RUN_EVERY_MS / 60000) + ' minuti.');
  runCycle(apiKey); // primo ciclo subito, non aspettare 5 minuti per il primo risultato
  setInterval(function () { runCycle(apiKey); }, RUN_EVERY_MS);
}

module.exports = { start: start, runCycle: runCycle };

if (require.main === module) {
  var apiKey = process.argv[2];
  if (!apiKey) {
    console.error('Uso: node scheduler.js <API_KEY>');
    process.exit(1);
  }
  start(apiKey);
}
