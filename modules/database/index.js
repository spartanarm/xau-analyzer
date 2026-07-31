// ══════════════════════════════════════════════════════════════════
// DATABASE — connessione e migrazioni.
//
// Il driver "pg" viene iniettato (mai importato qui in modo rigido):
// così nei test posso usare un finto database in memoria (vedi
// tests/fakePg.js), e in produzione Railway usa il vero driver
// installato durante la build. Stessa tecnica già usata altrove nel
// progetto per isolare ciò che dipende dalla rete/dall'ambiente.
//
// GARANZIA: se DATABASE_URL non è configurato, questo modulo resta
// semplicemente inattivo — niente crash, il servizio continua a
// funzionare come oggi (stato operativo su file, come sempre).

var fs = require('fs');
var path = require('path');

var pool = null;
var log = null;

function init(config, logging, driver) {
  log = logging.forComponent('database');
  var dbCfg = config.get().database;

  if (!dbCfg.enabled || !dbCfg.url) {
    log.info('database.disabled', 'nessun DATABASE_URL configurato: il modulo database resta inattivo');
    return null;
  }

  var pg = driver || require('pg');
  pool = new pg.Pool({
    connectionString: dbCfg.url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', function (err) {
    // un errore su una connessione IDLE nel pool non deve mai far
    // cadere il processo: lo registriamo e il pool ne apre una nuova
    // alla prossima richiesta.
    log.error('pool.error', 'errore su una connessione inattiva del pool', { error: err.message });
  });

  log.info('database.connecting', 'pool di connessione creato');
  return pool;
}

async function query(text, params) {
  if (!pool) throw new Error('database non inizializzato o disabilitato');
  return pool.query(text, params);
}

async function health() {
  if (!pool) return { connected: false, reason: 'database disabilitato' };
  try {
    await pool.query('SELECT 1');
    return { connected: true };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

// Migrazioni idempotenti: ogni file in migrations/ viene applicato UNA
// SOLA VOLTA (tracciato in schema_migrations), e si può rilanciare ad
// ogni avvio senza rischio — se è già tutto applicato, non fa nulla.
async function runMigrations() {
  if (!pool) return { applied: [], skipped: true };

  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );

  var dir = path.join(__dirname, 'migrations');
  var files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.sql'); }).sort();
  var applied = [];

  for (var i = 0; i < files.length; i++) {
    var version = files[i];
    var already = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (already.rows.length) continue;

    var sql = fs.readFileSync(path.join(dir, version), 'utf8');
    log.info('migration.applying', 'applico la migrazione ' + version);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    applied.push(version);
    log.info('migration.applied', 'migrazione applicata: ' + version);
  }

  return { applied: applied, skipped: false };
}

function isEnabled() { return pool !== null; }

function reset() { pool = null; log = null; } // per i test

module.exports = { init: init, query: query, health: health, runMigrations: runMigrations, isEnabled: isEnabled, reset: reset };
