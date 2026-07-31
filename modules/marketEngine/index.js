// ══════════════════════════════════════════════════════════════════
// MARKET ENGINE (modulo) — l'unica porta d'accesso al motore.
//
// CONTRATTO: candele in → analisi e piano tecnico out.
// Nessun altro modulo importa engine.js direttamente: passano tutti da
// qui. Così se un domani il motore cambia versione, c'è UN solo punto da
// adattare invece di cercarlo in tutto il progetto.
//
// ⚠️ engine.js è INTOCCABILE: 43 funzioni pure, 246 test. Questo modulo
// non ne modifica il comportamento — lo orchestra, esattamente come
// facevano il browser e l'harness di backtest.
//
// La funzione buildAnalysisFrame è la STESSA già verificata dai 246 test
// (proviene da replay_engine.js, riportata parola per parola): resta
// l'unico modo in cui candele grezze diventano bias/struttura/zone in
// tutto il progetto.

var engine = require('./engine.js');

function buildAnalysisFrame(candlesAtT, price, refTs, analysisCfg) {
  var C = analysisCfg;
  var kMap = { h4: C.swingK, h1: C.swingK + 1, m15: C.swingK + 1, m5: C.swingK + 2 };
  var tf = {};
  ['h4', 'h1', 'm15', 'm5'].forEach(function (k) {
    tf[k] = candlesAtT[k] && candlesAtT[k].length ? engine.buildTF(candlesAtT[k], C, kMap[k]) : { ok: false };
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
  var zones = price !== null ? engine.clusterZones(pts, C.zoneTolPct, price) : [];
  var res = zones.filter(function (z) { return z.low > price; }).sort(function (a, b) { return a.center - b.center; }).slice(0, 3);
  var sup = zones.filter(function (z) { return z.high < price; }).sort(function (a, b) { return b.center - a.center; }).slice(0, 3);
  var bias = engine.combineBias(tf);
  var setup = engine.buildSetup(bias.bias, tf, price, res, sup, atrH1);
  return { tf: tf, price: price, res: res, sup: sup, bias: bias, setup: setup, atrH1: atrH1 };
}

function lastClosedCandle(cd, tfMs, now) {
  if (!cd || !cd.length) return null;
  now = now || Date.now();
  for (var i = cd.length - 1; i >= 0; i--) {
    if (cd[i].t + tfMs <= now) return { c: cd[i].c, h: cd[i].h, l: cd[i].l, t: cd[i].t };
  }
  return null;
}

// Esegue un'analisi completa: è la funzione che l'orchestratore chiama.
// Restituisce tutto ciò che serve ai moduli a valle, senza che debbano
// conoscere i dettagli interni del motore.
function analyze(input) {
  var C = input.analysisCfg;
  var now = input.now;
  var candles = input.candles;
  var price = input.price;

  var core = buildAnalysisFrame(candles, price, now, C);

  var m15Closed = core.tf.m15.ok ? lastClosedCandle(core.tf.m15.candles, 15 * 60 * 1000, now) : null;
  var m5Closed = core.tf.m5.ok ? lastClosedCandle(core.tf.m5.candles, 5 * 60 * 1000, now) : null;
  var m5Dir = core.tf.m5.ok
    ? (core.tf.m5.structure.trend === 'BULLISH' ? 1 : core.tf.m5.structure.trend === 'BEARISH' ? -1 : 0)
    : null;

  var tracker = engine.advanceSetup(input.tracker, core.setup, {
    now: now, price: price, m15Closed: m15Closed, m5Dir: m5Dir, atrH1: core.atrH1
  });

  var techCtx = {
    sup: core.sup, res: core.res,
    m15: core.tf.m15.ok ? core.tf.m15.structure : null,
    h1: core.tf.h1.ok ? core.tf.h1.structure : null,
    atrM15: core.tf.m15.ok ? core.tf.m15.vol.atr : null,
    atrM5: core.tf.m5.ok ? core.tf.m5.vol.atr : null,
    m15Closed: m15Closed, m5Dir: m5Dir, m5Closed: m5Closed,
    now: now, lastTerminal: input.lastTerminal || null,
    stability: input.stability || [],
    rrThresholds: { aplus: C.rrAplus, a: C.rrA, b: C.rrB }
  };

  var plan = engine.buildTradePlan(tracker, core.bias, price, core.atrH1, C.minRR, techCtx);
  tracker = plan.tracker || tracker;

  var radar = engine.buildOpportunityRadar(input.radar || [], {
    price: price, atrH1: core.atrH1, atrExec: techCtx.atrM15, bias: core.bias.bias,
    sup: core.sup, res: core.res, m15: techCtx.m15, h1: techCtx.h1,
    m15Closed: techCtx.m15Closed, m5Bar: techCtx.m5Closed, now: now,
    tracker: tracker, thr: techCtx.rrThresholds, minRR: C.minRR
  });

  return {
    core: core, tracker: tracker, plan: plan, radar: radar,
    m15Closed: m15Closed, m5Closed: m5Closed,
    debugLines: engine.buildDebugLines ? null : null // disponibile su richiesta, non calcolato ad ogni ciclo
  };
}

module.exports = {
  analyze: analyze,
  buildAnalysisFrame: buildAnalysisFrame,
  lastClosedCandle: lastClosedCandle,
  raw: engine,                      // accesso diretto, per i test e la diagnostica
  SETUP_RULES: engine.SETUP_RULES
};
