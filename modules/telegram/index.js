// ══════════════════════════════════════════════════════════════════
// TELEGRAM — notifiche automatiche + comandi.
//
// SICUREZZA: risponde SOLO ai chat ID elencati in
// config.telegram.allowedChatIds (già validato dal Configuration Engine
// in Fase 1: non si può abilitare Telegram senza questa lista). Un
// messaggio da un chat non autorizzato viene ignorato in silenzio —
// niente eco, niente indizio che il bot esista per chi non è in lista.
//
// DEDUPLICA RADAR: ogni opportunità ha un id stabile nel tempo
// (verificato nel motore) — si notifica solo la PRIMA volta che un id
// compare, mai ad ogni ciclo in cui resta attiva.
//
// DISTINZIONE "setup invalidato" vs "Stop Loss": tenute separate
// tracciando quali setupId sono STATI APERTI come posizione (via
// POSITION_OPENED). Se un setup viene invalidato/scade SENZA essere mai
// stato aperto, è "setup invalidato". Se era aperto, la chiusura la
// notifica SOLO Position Tracker (via POSITION_SL_HIT/POSITION_TP1_HIT,
// con numeri precisi) — mai due messaggi per la stessa chiusura. Questa
// scelta non dipende dall'ordine di esecuzione dei sottoscrittori: si
// basa su un fatto storico (mai aperto), non su un timing di eventi.

var commands = require('./commands.js');
var clientMod = require('./client.js');

var RADAR_NOTIFIED_MAX = 50;

function attach(bus, config, logging, deps) {
  var cfg = config.get();
  if (!cfg.telegram.enabled) {
    logging.forComponent('telegram').info('telegram.disabled', 'Telegram non configurato: nessuna notifica, nessun comando');
    return false;
  }

  var log = logging.forComponent('telegram');
  var store = deps.store;
  var scheduler = deps.scheduler;
  var database = deps.database;
  var repo = deps.repo;
  var positionTracker = deps.positionTracker;
  var client = deps.client || clientMod.makeClient(cfg.telegram.botToken, deps.transport);

  var allowedChatIds = cfg.telegram.allowedChatIds.map(String);
  var openedSetupIds = new Set(store.load('telegram_opened_setup_ids', []));
  var radarNotified = store.load('telegram_radar_notified', []);

  function broadcast(text) {
    allowedChatIds.forEach(function (chatId) {
      client.sendMessage(chatId, text).catch(function (err) {
        log.error('send.failed', 'invio messaggio Telegram fallito', { error: err.message, chatId: chatId });
      });
    });
  }

  function rememberOpened(setupId) {
    openedSetupIds.add(setupId);
    store.save('telegram_opened_setup_ids', Array.from(openedSetupIds).slice(-200));
  }

  // ── NOTIFICHE ──

  bus.subscribe(bus.EVENTS.SETUP_CREATED, 'telegram', function (ev) {
    var p = ev.payload;
    broadcast('🚨 <b>Nuovo setup</b> ' + p.direction + ' su ' + p.symbol + '\n' + (p.reason || ''));
  });

  bus.subscribe(bus.EVENTS.POSITION_OPENED, 'telegram', function (ev) {
    var pos = ev.payload;
    rememberOpened(pos.setupId);
    broadcast('✅ <b>Trade attivato</b> ' + pos.direction + ' su ' + pos.symbol + '\n' +
      'Entry: ' + pos.entryPrice.toFixed(2) + ' · SL: ' + pos.sl.toFixed(2) +
      (pos.tp1 !== null && pos.tp1 !== undefined ? (' · TP1: ' + pos.tp1.toFixed(2)) : '') +
      (pos.tp2 !== null && pos.tp2 !== undefined ? (' · TP2: ' + pos.tp2.toFixed(2) + ' (informativo)') : ''));
  });

  bus.subscribe(bus.EVENTS.POSITION_TP1_HIT, 'telegram', function (ev) {
    var pos = ev.payload;
    broadcast('🎯 <b>TP1 raggiunto</b> su ' + pos.symbol + '\n' +
      'Uscita: ' + pos.exitPrice.toFixed(2) + ' · Risultato: ' + (pos.pnlR !== null ? ((pos.pnlR >= 0 ? '+' : '') + pos.pnlR.toFixed(2) + 'R') : 'n.d.'));
  });

  bus.subscribe(bus.EVENTS.POSITION_SL_HIT, 'telegram', function (ev) {
    var pos = ev.payload;
    broadcast('❌ <b>Stop Loss</b> su ' + pos.symbol + '\n' +
      'Uscita: ' + pos.exitPrice.toFixed(2) + ' · Risultato: ' + (pos.pnlR !== null ? pos.pnlR.toFixed(2) + 'R' : 'n.d.'));
  });

  function handleNeverOpenedTermination(ev, label) {
    var p = ev.payload;
    if (openedSetupIds.has(p.setupId)) return; // già gestito da Position Tracker con numeri precisi
    broadcast('⚠️ <b>' + label + '</b> su ' + p.symbol + (p.direction ? (' (' + p.direction + ')') : '') + '\n' + (p.reason || ''));
  }
  bus.subscribe(bus.EVENTS.SETUP_INVALIDATED, 'telegram', function (ev) { handleNeverOpenedTermination(ev, 'Setup invalidato'); });
  bus.subscribe(bus.EVENTS.SETUP_EXPIRED, 'telegram', function (ev) { handleNeverOpenedTermination(ev, 'Setup scaduto'); });

  bus.subscribe(bus.EVENTS.DECISION_BLOCKED, 'telegram', function (ev) {
    var p = ev.payload;
    var icona = p.blockedBy === 'news' ? '🔒' : '⛔';
    broadcast(icona + ' <b>Setup valido ma BLOCCATO</b> ' + (p.direction || '') + ' su ' + p.symbol + '\n' + (p.gateReason || ''));
  });

  bus.subscribe(bus.EVENTS.NEWS_HIGH_IMPACT_UPCOMING, 'telegram', function (ev) {
    var p = ev.payload;
    broadcast('⚠️ <b>News ad alto impatto in arrivo</b>\n' + p.title + ' tra ' + p.minutesAway + ' minuti');
  });

  bus.subscribe(bus.EVENTS.RADAR_OPPORTUNITY, 'telegram', function (ev) {
    var opportunities = ev.payload.opportunities || [];
    var fresh = opportunities.filter(function (o) { return radarNotified.indexOf(o.id) === -1; });
    if (!fresh.length) return;
    fresh.forEach(function (o) {
      broadcast('👀 <b>Opportunity Radar</b> ' + o.dir + ' · ' + o.setupType + ' su ' + ev.payload.symbol + '\n' +
        (o.trigger || ''));
      radarNotified.push(o.id);
    });
    radarNotified = radarNotified.slice(-RADAR_NOTIFIED_MAX);
    store.save('telegram_radar_notified', radarNotified);
  });

  log.info('telegram.attached', 'notifiche collegate all\'Event Bus', { chatIds: allowedChatIds.length });

  // ── COMANDI (long polling) ──
  var polling = false;
  var offset = store.load('telegram_update_offset', 0);

  var COMMAND_TABLE = {
    '/status': function () { return commands.cmdStatus({ scheduler: scheduler, config: config, database: database, store: store }); },
    '/market': function () { return commands.cmdMarket({ store: store }); },
    '/setup': function () { return commands.cmdSetup({ store: store }); },
    '/open': function () { return commands.cmdOpen({ positionTracker: positionTracker }, 'XAU/USD'); },
    '/history': function () { return commands.cmdHistory({ config: config, repo: repo }, 'XAU/USD'); },
    '/stats': function () { return commands.cmdStats({ config: config, repo: repo }, 'XAU/USD'); },
    '/news': function () { return commands.cmdNews({ config: config, store: store, newsEngine: require('../news/index.js'), newsStats: require('../news/scheduler.js').getStats }); },
    '/help': function () { return commands.cmdHelp(); }
  };

  var POLL_ERROR_BACKOFF_MS = deps.pollErrorBackoffMs || 5000;

  async function pollOnce() {
    var updates;
    try {
      updates = await client.getUpdates(offset, 25);
    } catch (err) {
      log.error('poll.failed', 'getUpdates fallito', { error: err.message });
      // GARANZIA: mai ripetere a raffica dopo un errore — un problema di
      // rete persistente non deve martellare l'API di Telegram né
      // riempire i log a velocità incontrollata.
      await new Promise(function (r) { setTimeout(r, POLL_ERROR_BACKOFF_MS); });
      return;
    }
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      offset = u.update_id + 1;
      store.save('telegram_update_offset', offset);

      if (!u.message || !u.message.text) continue;
      var chatId = String(u.message.chat.id);
      if (allowedChatIds.indexOf(chatId) === -1) {
        log.warn('command.rejected', 'messaggio da chat non autorizzato ignorato', { chatId: chatId });
        continue; // MAI rispondere a chi non è autorizzato
      }
      var text = u.message.text.trim().split(' ')[0].toLowerCase();
      var handler = COMMAND_TABLE[text];
      if (!handler) continue; // testo non riconosciuto: nessuna risposta rumorosa
      try {
        var reply = await handler();
        await client.sendMessage(chatId, reply);
      } catch (err) {
        log.error('command.failed', 'errore nell\'esecuzione del comando ' + text, { error: err.message });
        try { await client.sendMessage(chatId, '⚠️ Si è verificato un errore interno.'); } catch (e2) { /* silenzioso */ }
      }
    }
  }

  async function pollLoop() {
    while (polling) {
      try { await pollOnce(); }
      catch (err) { log.error('poll.unhandled', 'errore non gestito nel polling', { error: err.message }); }
    }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    pollLoop();
    log.info('polling.started', 'in ascolto dei comandi Telegram');
  }
  function stopPolling() { polling = false; }

  return { startPolling: startPolling, stopPolling: stopPolling, pollOnce: pollOnce };
}

module.exports = { attach: attach };
