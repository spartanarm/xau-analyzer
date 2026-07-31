// ══════════════════════════════════════════════════════════════════
// DATABASE LISTENER — collega l'Event Bus al database.
//
// Un consumatore come tutti gli altri (Telegram sarà il prossimo):
// l'orchestratore non sa che il database esiste, pubblica eventi e
// basta. Se questo modulo fallisce, l'Event Bus lo isola (verificato
// nei test di Fase 1) — il ciclo di analisi prosegue comunque.
//
// Se il database non è configurato (config.database.enabled === false),
// questo modulo semplicemente non si iscrive a nulla: zero costo, zero
// rischio, il servizio si comporta esattamente come prima della Fase 2.

var repo = require('./repository.js');

var STATE_EVENT_TYPES = null; // popolato all'avvio da bus.EVENTS

function attach(bus, config, logging) {
  var cfg = config.get();
  if (!cfg.database.enabled) {
    logging.forComponent('database-listener').info('listener.disabled', 'database non configurato: nessuna sottoscrizione');
    return false;
  }

  var log = logging.forComponent('database-listener');

  var lifecycleEvents = [
    bus.EVENTS.SETUP_CREATED, bus.EVENTS.SETUP_CONFIRMED, bus.EVENTS.SETUP_TOUCHED,
    bus.EVENTS.SETUP_INVALIDATED, bus.EVENTS.SETUP_EXPIRED, bus.EVENTS.SETUP_MISSED,
    bus.EVENTS.SETUP_TRADE_READY, bus.EVENTS.SETUP_PENDING_LIMIT, bus.EVENTS.SETUP_TARGET_HIT
  ];

  lifecycleEvents.forEach(function (eventType) {
    bus.subscribe(eventType, 'database', function (ev) {
      return repo.recordSetupLifecycleEvent(ev).catch(function (err) {
        log.error('write.failed', 'scrittura setup fallita per ' + eventType, { error: err.message, setupId: ev.payload.setupId });
      });
    });
  });

  bus.subscribe(bus.EVENTS.CYCLE_COMPLETED, 'database', function (ev) {
    return repo.insertAnalysis(ev).catch(function (err) {
      log.error('write.failed', 'scrittura analisi fallita', { error: err.message });
    });
  });

  bus.subscribe(bus.EVENTS.POSITION_OPENED, 'database', function (ev) {
    return repo.insertPosition(ev.payload).catch(function (err) {
      log.error('write.failed', 'scrittura apertura posizione fallita', { error: err.message, setupId: ev.payload.setupId });
    });
  });

  bus.subscribe(bus.EVENTS.POSITION_CLOSED, 'database', function (ev) {
    return repo.closePositionRecord(ev.payload).catch(function (err) {
      log.error('write.failed', 'scrittura chiusura posizione fallita', { error: err.message, setupId: ev.payload.setupId });
    });
  });

  log.info('listener.attached', 'database collegato all\'Event Bus', { events: lifecycleEvents.length + 1 });
  return true;
}

module.exports = { attach: attach };
