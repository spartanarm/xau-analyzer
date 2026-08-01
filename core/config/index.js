// ══════════════════════════════════════════════════════════════════
// CONFIGURATION ENGINE — punto UNICO da cui ogni modulo legge i propri
// parametri. Nessun valore sparso nel codice.
//
// TRE LIVELLI, in ordine di precedenza (l'ultimo vince):
//   1. valori di default dichiarati qui sotto
//   2. variabili d'ambiente (per i segreti e per ciò che cambia per
//      ambiente: chiavi API, porta, percorsi)
//   3. override a runtime (in futuro dal database, per cambiare un
//      parametro senza riavviare — l'infrastruttura è già predisposta)
//
// CONFINE DICHIARATO CON IL MOTORE:
// I parametri interni del motore (SETUP_RULES: slBufferAtr, minStopAtr,
// noChaseAtr, soglie radar...) restano di proprietà di engine.js, che è
// intoccabile. Questo modulo li ESPONE in sola lettura, così esiste un
// unico posto dove vedere TUTTI i parametri del sistema, ma modificarli
// richiede una revisione del motore e la riesecuzione dei 246 test.
// Sono marcati esplicitamente come `engineOwned`.

var engine = require('../../modules/marketEngine/engine.js');

// ── 1. DEFAULT ─────────────────────────────────────────────────────
var defaults = {

  // Analisi tecnica: parametri che il motore RICEVE dall'esterno.
  // Questi sono per-strumento: la struttura è già pronta per il
  // multi-strumento (XAU/USD oggi, altri domani con soglie proprie).
  instruments: {
    'XAU/USD': {
      enabled: true,
      timeframes: ['h4', 'h1', 'm15', 'm5'],
      analysis: {
        swingK: 2,
        zoneTolPct: 0.12,
        eqTolPct: 0.05,
        atrPeriod: 14,
        swingAtrMult: 0.5,
        minRR: 1.5,
        rrAplus: 1.25,
        rrA: 1.25,
        rrB: 1.5,
        brokerOffset: 0
      }
    }
  },

  // Acquisizione dati di mercato
  marketData: {
    provider: 'twelvedata',
    apiKey: null,                 // da variabile d'ambiente, mai qui
    rateLimitPerMin: 7,           // margine sotto il limite reale di 8
    updateOutputsize: 20,         // candele richieste per aggiornamento
    candleWindowSize: 200         // storico mantenuto in cache per timeframe
  },

  // Orchestratore
  scheduler: {
    runEveryMs: 5 * 60 * 1000,
    skipIfNoNewCandle: true       // anti-ricalcolo: salta se nulla è cambiato
  },

  // News (predisposto — attivato in Fase 5)
  news: {
    enabled: false,
    provider: null,               // 'builtin' | 'fmp' | 'finnhub'
    customEvents: [],             // eventi aggiunti a mano: [{date:'2026-08-12', etHour:8, etMinute:30, title:'CPI YoY'}]
    apiKey: null,
    refreshEveryMs: 6 * 60 * 60 * 1000,
    highImpactKeywords: ['FOMC', 'CPI', 'NFP', 'Non-Farm', 'PPI', 'PCE',
      'Powell', 'ADP', 'ISM', 'PMI', 'GDP', 'Jobless Claims', 'Retail Sales',
      'Interest Rate', 'Unemployment'],
    lockBeforeMs: 30 * 60 * 1000, // finestra di blocco PRIMA dell'evento
    lockAfterMs: 15 * 60 * 1000   // e DOPO
  },

  // Risk Engine (predisposto — attivato in Fase 6)
  risk: {
    enabled: false,
    accountCapital: null,
    riskPercentPerTrade: 1.0,
    maxOpenPositions: 1,
    maxDailyLossPercent: 3.0,
    maxDailyTrades: 5
  },

  // Telegram (predisposto — attivato in Fase 4)
  telegram: {
    enabled: false,
    botToken: null,
    allowedChatIds: []            // SOLO questi ID ricevono e possono comandare
  },

  // Database (attivato in Fase 2)
  database: {
    enabled: false,
    url: null
  },

  // Server / dashboard
  server: {
    port: 3000
  },

  // Log
  logging: {
    level: 'INFO',                // DEBUG | INFO | WARN | ERROR
    toFile: true,
    toDatabase: false,            // attivato in Fase 2
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFiles: 5
  },

  // Percorsi
  paths: {
    dataDir: null                 // da variabile d'ambiente (volume)
  }
};

// ── 2. OVERRIDE DA VARIABILI D'AMBIENTE ────────────────────────────
// Solo ciò che è segreto o dipende dall'ambiente. Mappatura esplicita:
// nessuna magia, si vede a occhio da dove viene ogni valore.
function applyEnv(cfg) {
  var env = process.env;

  if (env.TWELVEDATA_API_KEY) cfg.marketData.apiKey = env.TWELVEDATA_API_KEY;
  if (env.DATA_DIR) cfg.paths.dataDir = env.DATA_DIR;
  if (env.PORT) cfg.server.port = parseInt(env.PORT, 10);

  if (env.NEWS_PROVIDER) { cfg.news.provider = env.NEWS_PROVIDER; cfg.news.enabled = true; }
  if (env.NEWS_API_KEY) cfg.news.apiKey = env.NEWS_API_KEY;

  if (env.TELEGRAM_BOT_TOKEN) { cfg.telegram.botToken = env.TELEGRAM_BOT_TOKEN; cfg.telegram.enabled = true; }
  if (env.TELEGRAM_CHAT_IDS) {
    cfg.telegram.allowedChatIds = env.TELEGRAM_CHAT_IDS.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  if (env.DATABASE_URL) { cfg.database.url = env.DATABASE_URL; cfg.database.enabled = true; }

  if (env.LOG_LEVEL) cfg.logging.level = env.LOG_LEVEL.toUpperCase();

  if (env.ACCOUNT_CAPITAL) { cfg.risk.accountCapital = parseFloat(env.ACCOUNT_CAPITAL); cfg.risk.enabled = true; }
  if (env.RISK_PERCENT) cfg.risk.riskPercentPerTrade = parseFloat(env.RISK_PERCENT);

  return cfg;
}

// ── 3. VALIDAZIONE — fallire subito e con un messaggio chiaro ───────
// Meglio un errore all'avvio che un comportamento silenziosamente
// sbagliato a mercato aperto.
function validate(cfg) {
  var errors = [];

  if (!cfg.marketData.apiKey) {
    errors.push('marketData.apiKey mancante — imposta la variabile TWELVEDATA_API_KEY');
  }
  if (!(cfg.scheduler.runEveryMs > 0)) {
    errors.push('scheduler.runEveryMs deve essere maggiore di zero');
  }
  if (cfg.marketData.rateLimitPerMin < 1 || cfg.marketData.rateLimitPerMin > 8) {
    errors.push('marketData.rateLimitPerMin fuori range sicuro (1-8): il limite reale di Twelve Data è 8/min');
  }
  if (['DEBUG', 'INFO', 'WARN', 'ERROR'].indexOf(cfg.logging.level) === -1) {
    errors.push('logging.level non valido: ammessi DEBUG, INFO, WARN, ERROR');
  }
  if (cfg.telegram.enabled && !cfg.telegram.allowedChatIds.length) {
    errors.push('telegram abilitato ma allowedChatIds è vuoto: il bot risponderebbe a CHIUNQUE — imposta TELEGRAM_CHAT_IDS');
  }
  if (cfg.news.enabled && !cfg.news.provider) {
    errors.push('news abilitato ma provider non specificato');
  }
  if (cfg.risk.enabled && !(cfg.risk.accountCapital > 0)) {
    errors.push('risk abilitato ma accountCapital non valido');
  }

  var enabledInstruments = Object.keys(cfg.instruments).filter(function (s) { return cfg.instruments[s].enabled; });
  if (!enabledInstruments.length) errors.push('nessuno strumento abilitato in instruments');

  return errors;
}

// ── Congelamento profondo: un modulo non può alterare la config
// condivisa per sbaglio, causando comportamenti diversi altrove.
function deepFreeze(o) {
  Object.getOwnPropertyNames(o).forEach(function (k) {
    if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
  });
  return Object.freeze(o);
}

var _cfg = null;
var _errors = null;

function load(opts) {
  opts = opts || {};
  var cfg = JSON.parse(JSON.stringify(defaults));
  if (!opts.skipEnv) cfg = applyEnv(cfg);
  if (opts.overrides) {
    // override espliciti (usati dai test e, in futuro, dal database)
    Object.keys(opts.overrides).forEach(function (section) {
      cfg[section] = Object.assign({}, cfg[section], opts.overrides[section]);
    });
  }
  _errors = validate(cfg);

  // Parametri interni del motore: esposti in SOLA LETTURA, non modificabili
  // da qui. Il motore ne resta proprietario (vedi commento in testa).
  cfg.engineOwned = {
    _readOnly: true,
    _note: 'Costanti strutturali interne a engine.js. Modificarle richiede toccare il motore e rieseguire tutti i test.',
    setupRules: JSON.parse(JSON.stringify(engine.SETUP_RULES))
  };

  _cfg = deepFreeze(cfg);
  return _cfg;
}

function get() {
  if (!_cfg) load();
  return _cfg;
}

function errors() {
  if (!_errors) load();
  return _errors;
}

// Vista appiattita di TUTTI i parametri, per la dashboard e per il
// comando /status di Telegram: un solo posto dove vedere tutto.
function describe() {
  var cfg = get();
  var out = [];
  function walk(obj, prefix) {
    Object.keys(obj).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      var v = obj[k];
      var key = prefix ? (prefix + '.' + k) : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else {
        // i segreti non vengono mai mostrati in chiaro
        var isSecret = /apiKey|botToken|url|password/i.test(k);
        out.push({ key: key, value: isSecret && v ? '***' : v });
      }
    });
  }
  walk(cfg, '');
  return out;
}

module.exports = { load: load, get: get, errors: errors, describe: describe, defaults: defaults };
