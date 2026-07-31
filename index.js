// ══════════════════════════════════════════════════════════════════
// INDEX.JS — punto di avvio unico.
//
// Ordine deliberato:
//   1. CONFIG    — se la configurazione non è valida, meglio fermarsi
//                  subito con un messaggio chiaro che partire a metà
//   2. LOGGER    — configurato prima di tutto il resto, così anche gli
//                  errori di avvio finiscono nei log
//   3. EVENT BUS — collegato al logger, così un consumatore che va in
//                  errore lascia una traccia diagnosticabile
//   4. API       — parte prima dell'orchestratore, così la pagina
//                  risponde subito ("in attesa del primo ciclo") invece
//                  di dare errore di connessione
//   5. ORCHESTRATORE — per ultimo: da qui inizia il lavoro vero

var config = require('./core/config/index.js');
var logging = require('./core/logging/index.js');
var bus = require('./core/events/index.js');
var path = require('path');

// ── 1. CONFIG ──
var cfg = config.load();
var errors = config.errors();
if (errors.length) {
  console.error('');
  console.error('❌ CONFIGURAZIONE NON VALIDA — il servizio non parte:');
  errors.forEach(function (e) { console.error('   · ' + e); });
  console.error('');
  process.exit(1);
}

// ── 2. LOGGER ──
var logDir = cfg.paths.dataDir ? path.join(cfg.paths.dataDir, 'logs') : path.join(__dirname, 'data', 'logs');
logging.configure({
  level: cfg.logging.level,
  toFile: cfg.logging.toFile,
  dir: logDir,
  maxFileSizeBytes: cfg.logging.maxFileSizeBytes,
  maxFiles: cfg.logging.maxFiles
});
var log = logging.forComponent('bootstrap');

// ── 3. EVENT BUS collegato al logger ──
bus.setErrorReporter(function (info) {
  logging.forComponent('event-bus').error('consumer.failed', info.message, { handler: info.handler, eventType: info.eventType });
});

// ── 4 e 5 ──
var api = require('./modules/api/server.js');
var scheduler = require('./modules/orchestrator/scheduler.js');

log.info('service.starting', 'avvio piattaforma XAU/USD', {
  instruments: Object.keys(cfg.instruments).filter(function (s) { return cfg.instruments[s].enabled; }),
  dataDir: cfg.paths.dataDir,
  modules: { news: cfg.news.enabled, risk: cfg.risk.enabled, telegram: cfg.telegram.enabled, database: cfg.database.enabled }
});

api.start();
scheduler.start();
bus.publish(bus.EVENTS.SERVICE_STARTED, { at: Date.now() });

// Un errore non gestito non deve far morire il servizio in silenzio:
// lo registriamo e restiamo in piedi (il ciclo successivo riprova).
process.on('uncaughtException', function (err) {
  log.error('uncaught', 'eccezione non gestita, il servizio resta attivo', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', function (reason) {
  log.error('unhandledRejection', 'promise rifiutata non gestita', { reason: String(reason) });
});
