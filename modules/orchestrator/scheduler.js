// ══════════════════════════════════════════════════════════════════
// ORCHESTRATORE — coordina il ciclo, non decide nulla.
//
// Responsabilità: sapere QUANDO analizzare, chiedere i dati, invocare il
// Market Engine, salvare, e PUBBLICARE cosa è accaduto. Non contiene
// logica di trading: quella vive tutta dentro engine.js.
//
// ANTI-RICALCOLO (richiesto): se non è chiusa nessuna nuova candela dal
// ciclo precedente, il ciclo viene saltato. Due benefici:
//   1. non spreca richieste API né calcolo
//   2. non ripubblica eventi già emessi — essenziale ora che c'è l'Event
//      Bus, altrimenti Telegram invierebbe la stessa notifica ogni 5
//      minuti finché il setup resta invariato.

var config = require('../../core/config/index.js');
var logging = require('../../core/logging/index.js');
var bus = require('../../core/events/index.js');
var store = require('../persistence/stateStore.js');
var marketEngine = require('../marketEngine/index.js');
var fetcher = require('../marketData/fetcher.js');

var log = logging.forComponent('orchestrator');
var timer = null;
var stats = { cyclesRun: 0, cyclesSkipped: 0, cyclesFailed: 0, lastRunAt: null, lastError: null, startedAt: null };

// Mappa gli stati del tracker sugli eventi. Gli stati sono quelli che il
// motore già produce: non ne inventiamo di nuovi.
var STATE_EVENTS = {
  ACTIVATED: bus.EVENTS.SETUP_CONFIRMED,
  RETEST: bus.EVENTS.SETUP_TOUCHED,
  INVALIDATED: bus.EVENTS.SETUP_INVALIDATED,
  EXPIRED: bus.EVENTS.SETUP_EXPIRED,
  TARGET_HIT: bus.EVENTS.POSITION_TP1_HIT
};
var PLAN_STATUS_EVENTS = {
  TRADE_READY: bus.EVENTS.SETUP_TRADE_READY,
  PENDING_LIMIT: bus.EVENTS.SETUP_PENDING_LIMIT,
  MISSED_ENTRY: bus.EVENTS.SETUP_MISSED
};

function sym(symbol) { return symbol.replace('/', ''); }

// Firma dell'ultima candela chiusa per ogni timeframe: se non cambia,
// non c'è nulla di nuovo da analizzare.
function candleSignature(candles) {
  if (!candles) return null;
  return ['m5', 'm15', 'h1', 'h4'].map(function (k) {
    var arr = candles[k];
    return (arr && arr.length) ? arr[arr.length - 1].t : 0;
  }).join('|');
}

async function runCycle(symbol) {
  symbol = symbol || 'XAU/USD';
  var cfg = config.get();
  var inst = cfg.instruments[symbol];
  if (!inst || !inst.enabled) { log.warn('cycle.skip', 'strumento non abilitato: ' + symbol); return; }

  var S = sym(symbol);
  bus.publish(bus.EVENTS.CYCLE_STARTED, { symbol: symbol });

  // 1. dati di mercato
  var candles;
  try {
    candles = await fetcher.fetchAllTimeframes();
  } catch (err) {
    stats.cyclesFailed++;
    stats.lastError = { at: Date.now(), message: err.message };
    log.error('cycle.failed', 'ciclo interrotto: dati di mercato non disponibili', { error: err.message });
    bus.publish(bus.EVENTS.CYCLE_FAILED, { symbol: symbol, error: err.message });
    return;
  }

  var m5 = candles.m5;
  var price = (m5 && m5.length) ? m5[m5.length - 1].c : null;
  if (price === null) {
    log.warn('cycle.skip', 'nessun prezzo disponibile');
    bus.publish(bus.EVENTS.CYCLE_SKIPPED, { symbol: symbol, reason: 'no_price' });
    return;
  }

  // 2. ANTI-RICALCOLO
  var sig = candleSignature(candles);
  var prevSig = store.load('candle_sig_' + S, null);
  if (cfg.scheduler.skipIfNoNewCandle && prevSig === sig) {
    stats.cyclesSkipped++;
    log.debug('cycle.skipped', 'nessuna nuova candela chiusa: analisi invariata');
    bus.publish(bus.EVENTS.CYCLE_SKIPPED, { symbol: symbol, reason: 'no_new_candle' });
    return;
  }

  // 3. stato persistito
  var prevTracker = store.load('setup_' + S, null);
  var stability = store.load('stability_' + S, []);
  var radar = store.load('radar_' + S, []);
  var lastTerminal = store.load('lastterm_' + S, null);
  var prevTrackerId = prevTracker ? prevTracker.id : null;
  var prevState = prevTracker ? prevTracker.state : null;
  var prevPlanSig = store.load('plansig_' + S, null);

  // 4. MOTORE (invariato)
  var now = Date.now();
  var result;
  try {
    result = marketEngine.analyze({
      candles: candles, price: price, now: now,
      analysisCfg: inst.analysis,
      tracker: prevTracker, stability: stability, radar: radar, lastTerminal: lastTerminal
    });
  } catch (err) {
    stats.cyclesFailed++;
    stats.lastError = { at: now, message: err.message };
    log.error('engine.failed', 'il motore ha restituito un errore', { error: err.message });
    bus.publish(bus.EVENTS.CYCLE_FAILED, { symbol: symbol, error: err.message });
    return;
  }

  var tracker = result.tracker, plan = result.plan;

  // 5. salvataggio
  store.save('setup_' + S, tracker);
  store.save('radar_' + S, result.radar);
  store.save('candle_sig_' + S, sig);
  if (tracker && tracker.terminalAt) {
    store.save('lastterm_' + S, {
      id: tracker.id, dir: tracker.dir, key: tracker.key, outcome: tracker.outcome,
      terminalAt: tracker.terminalAt, confirm: tracker.confirm,
      retestEntry: tracker.retest ? tracker.retest.entry : null
    });
  }

  var snapshot = {
    generatedAt: now, symbol: symbol, price: price,
    priceTime: (m5 && m5.length) ? m5[m5.length - 1].t : null,
    bias: result.core.bias, plan: plan, radar: result.radar,
    zones: { support: result.core.sup, resistance: result.core.res },
    atr: { h1: result.core.atrH1, m15: result.core.tf.m15.ok ? result.core.tf.m15.vol.atr : null }
  };
  store.save('latest_snapshot', snapshot);
  store.save('latest_snapshot_' + S, snapshot);

  // 6. EVENTI: solo sulle transizioni reali
  publishLifecycleEvents({
    symbol: symbol, S: S, tracker: tracker, plan: plan, radar: result.radar, core: result.core,
    prevTrackerId: prevTrackerId, prevState: prevState, prevPlanSig: prevPlanSig
  });

  stats.cyclesRun++;
  stats.lastRunAt = now;
  log.info('cycle.completed', 'ciclo completato', {
    symbol: symbol, price: price, bias: result.core.bias.bias,
    action: plan.action, status: plan.status, mode: plan.executionMode,
    setupId: tracker ? tracker.id : null
  });
  bus.publish(bus.EVENTS.CYCLE_COMPLETED, { symbol: symbol, snapshot: snapshot });
}

// Contesto condiviso da allegare a QUALSIASI evento di ciclo di vita:
// così chi ascolta (il database, in futuro l'AI Performance Engine) ha
// sempre tutto il necessario per un salvataggio completo, indipendentemente
// da quale specifico evento sia scattato in questo ciclo.
function buildSetupContext(core, plan) {
  function tfInfo(tf) {
    return tf && tf.ok ? { trend: tf.structure.trend, state: tf.structure.state, lastEvent: tf.structure.lastEvent || null } : null;
  }
  return {
    marketStructure: { h4: tfInfo(core.tf.h4), h1: tfInfo(core.tf.h1), m15: tfInfo(core.tf.m15), m5: tfInfo(core.tf.m5) },
    zones: { support: core.sup, resistance: core.res },
    atrH1: core.atrH1,
    atrM15: core.tf.m15.ok ? core.tf.m15.vol.atr : null,
    quality: plan.quality || null,
    reason: plan.reason || null,
    // dati del piano: inclusi SEMPRE, non solo sui tre eventi dedicati —
    // molti setup restano a lungo in stati intermedi (WAITING_RETEST,
    // WAITING_CONFIRMATION) che l'engine valorizza comunque con entry/SL/TP
    // indicativi; senza questo, quei setup finirebbero nel database con
    // numeri vuoti anche se il motore li ha già calcolati.
    orderType: plan.orderType || null,
    executionMode: plan.executionMode || null,
    entryLo: plan.entryLo !== undefined ? plan.entryLo : null,
    entryHi: plan.entryHi !== undefined ? plan.entryHi : null,
    sl: plan.sl !== undefined ? plan.sl : null,
    tp1: plan.tp1 !== undefined ? plan.tp1 : null,
    tp2: plan.tp2 !== undefined ? plan.tp2 : null,
    tpFast: plan.tpFast !== undefined ? plan.tpFast : null,
    rr1: plan.rr1 !== undefined ? plan.rr1 : null,
    rr2: plan.rr2 !== undefined ? plan.rr2 : null,
    requiredRR: plan.requiredRR !== undefined ? plan.requiredRR : null
  };
}

function publishLifecycleEvents(ctx) {
  var tracker = ctx.tracker, plan = ctx.plan;
  var setupCtx = buildSetupContext(ctx.core, plan);

  // nuovo setup
  if (tracker && tracker.id && tracker.id !== ctx.prevTrackerId) {
    bus.publish(bus.EVENTS.SETUP_CREATED, Object.assign({
      symbol: ctx.symbol, setupId: tracker.id, direction: tracker.dir, status: tracker.state,
      confirm: tracker.confirm, invalid: tracker.invalid, target: tracker.target
    }, setupCtx));
  } else if (tracker && tracker.state !== ctx.prevState) {
    // transizione di stato di un setup già esistente
    var evType = STATE_EVENTS[tracker.state];
    if (evType) {
      bus.publish(evType, Object.assign({
        symbol: ctx.symbol, setupId: tracker.id, direction: tracker.dir, from: ctx.prevState, to: tracker.state, status: tracker.state,
        invalid: tracker.invalid, outcome: tracker.outcome || null
      }, setupCtx, { reason: tracker.note || setupCtx.reason }));
    }
  }

  // stato del piano: firma per non ripubblicare lo stesso stato
  var planSig = [plan.status, plan.orderType, tracker ? tracker.id : ''].join('|');
  if (planSig !== ctx.prevPlanSig) {
    var planEv = PLAN_STATUS_EVENTS[plan.status];
    if (planEv) {
      bus.publish(planEv, Object.assign({
        symbol: ctx.symbol, setupId: tracker ? tracker.id : null, status: plan.status, direction: plan.direction
      }, setupCtx));
    }
    store.save('plansig_' + ctx.S, planSig);
  }

  var active = (ctx.radar || []).filter(function (o) { return o.status !== 'EXPIRED' && o.status !== 'INVALIDATED'; });
  if (active.length) {
    bus.publish(bus.EVENTS.RADAR_OPPORTUNITY, { symbol: ctx.symbol, opportunities: active });
  }
}

function start() {
  var cfg = config.get();
  stats.startedAt = Date.now();
  var symbols = Object.keys(cfg.instruments).filter(function (s) { return cfg.instruments[s].enabled; });

  log.info('scheduler.started', 'orchestratore avviato', {
    everyMs: cfg.scheduler.runEveryMs, symbols: symbols, antiRecalc: cfg.scheduler.skipIfNoNewCandle
  });

  function tick() {
    symbols.forEach(function (s) {
      runCycle(s).catch(function (err) {
        log.error('cycle.unhandled', 'errore non gestito nel ciclo', { symbol: s, error: err.message });
      });
    });
  }
  tick();
  timer = setInterval(tick, cfg.scheduler.runEveryMs);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function getStats() {
  return Object.assign({}, stats, { uptimeMs: stats.startedAt ? (Date.now() - stats.startedAt) : 0 });
}

module.exports = { start: start, stop: stop, runCycle: runCycle, getStats: getStats };
