// ══════════════════════════════════════════════════════════════════
// LOGGER — log strutturati, non semplici console.log.
//
// Ogni riga porta: quando, gravità, quale modulo, tipo di evento,
// messaggio, e un contesto in JSON. Così un problema si diagnostica
// senza doverlo riprodurre.
//
// TRE DESTINAZIONI, per ragioni diverse:
//   · console  → per vedere cosa succede nei log di Railway
//   · file     → sul volume permanente, sopravvive ai riavvii; serve
//                quando il problema È il database (in quel caso i log
//                su database non li potresti leggere)
//   · database → in Fase 2, solo per gli eventi rilevanti su cui fare
//                statistiche e diagnosi storica
//
// REGOLA DI SICUREZZA: un errore nella scrittura del log non deve MAI
// far fallire chi lo ha chiamato. Se il disco è pieno, il servizio
// continua a operare — al massimo perde delle righe di log.

var fs = require('fs');
var path = require('path');

var LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

var state = {
  level: 'INFO',
  toFile: true,
  dir: null,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxFiles: 5,
  dbWriter: null,        // impostato in Fase 2
  ring: [],              // ultimi N record, per la dashboard
  ringMax: 300,
  configured: false
};

function configure(opts) {
  opts = opts || {};
  if (opts.level && LEVELS[opts.level]) state.level = opts.level;
  if (opts.toFile !== undefined) state.toFile = opts.toFile;
  if (opts.dir) state.dir = opts.dir;
  if (opts.maxFileSizeBytes) state.maxFileSizeBytes = opts.maxFileSizeBytes;
  if (opts.maxFiles) state.maxFiles = opts.maxFiles;
  if (state.toFile && state.dir) {
    try { if (!fs.existsSync(state.dir)) fs.mkdirSync(state.dir, { recursive: true }); }
    catch (e) { state.toFile = false; console.error('[logger] impossibile creare la cartella log, scrittura su file disattivata:', e.message); }
  }
  state.configured = true;
}

function setDbWriter(fn) { state.dbWriter = fn; }

function logFilePath() { return path.join(state.dir, 'app.log'); }

function rotateIfNeeded() {
  try {
    var p = logFilePath();
    if (!fs.existsSync(p)) return;
    var size = fs.statSync(p).size;
    if (size < state.maxFileSizeBytes) return;
    // ruota: app.log → app.log.1 → app.log.2 ...
    for (var i = state.maxFiles - 1; i >= 1; i--) {
      var from = p + '.' + i, to = p + '.' + (i + 1);
      if (fs.existsSync(from)) {
        if (i + 1 > state.maxFiles) fs.unlinkSync(from);
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(p, p + '.1');
  } catch (e) { /* mai far fallire il chiamante per un problema di rotazione */ }
}

function write(level, component, eventType, message, context) {
  if (LEVELS[level] < LEVELS[state.level]) return null;

  var record = {
    at: new Date().toISOString(),
    level: level,
    component: component,
    event: eventType || null,
    message: message,
    context: context || null
  };

  // ring buffer in memoria (per la dashboard: log recenti senza query)
  state.ring.push(record);
  if (state.ring.length > state.ringMax) state.ring.shift();

  // console
  var line = '[' + record.at + '] ' + level.padEnd(5) + ' [' + component + ']' +
    (eventType ? (' ' + eventType) : '') + ' ' + message +
    (context ? (' ' + safeJson(context)) : '');
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  // file
  if (state.toFile && state.dir) {
    try {
      rotateIfNeeded();
      fs.appendFileSync(logFilePath(), JSON.stringify(record) + '\n');
    } catch (e) { /* silenzioso di proposito: il log non deve rompere il servizio */ }
  }

  // database (Fase 2)
  if (state.dbWriter) {
    try {
      var r = state.dbWriter(record);
      if (r && typeof r.catch === 'function') r.catch(function () { });
    } catch (e) { /* idem */ }
  }

  return record;
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch (e) { return '[contesto non serializzabile]'; }
}

// Crea un logger "etichettato" per un modulo: così ogni modulo non deve
// ripetere il proprio nome a ogni chiamata.
function forComponent(component) {
  return {
    debug: function (event, msg, ctx) { return write('DEBUG', component, event, msg, ctx); },
    info: function (event, msg, ctx) { return write('INFO', component, event, msg, ctx); },
    warn: function (event, msg, ctx) { return write('WARN', component, event, msg, ctx); },
    error: function (event, msg, ctx) { return write('ERROR', component, event, msg, ctx); }
  };
}

function recent(limit) { return state.ring.slice(-(limit || 50)); }
function getState() { return { level: state.level, toFile: state.toFile, dir: state.dir, configured: state.configured, buffered: state.ring.length }; }
function reset() { state.ring = []; state.dbWriter = null; }

module.exports = {
  configure: configure,
  forComponent: forComponent,
  setDbWriter: setDbWriter,
  recent: recent,
  getState: getState,
  reset: reset,
  LEVELS: LEVELS
};
