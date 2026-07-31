// ══════════════════════════════════════════════════════════════════
// FINTO DRIVER POSTGRES — per i test, quando non c'è un Postgres vero
// a disposizione (come in questo ambiente di sviluppo, senza accesso a
// internet). Si comporta come "pg" nell'interfaccia che il resto del
// codice usa davvero (new Pool(), pool.query(), pool.on('error', ...)),
// ma registra ogni domanda ricevuta invece di parlare con un database
// reale. Verifica che IL NOSTRO codice generi le query giuste — non
// sostituisce la prova finale con Postgres vero su Railway.

function FakePool(opts) {
  this.opts = opts;
  this.queries = [];       // ogni query ricevuta: {text, params}
  this.tables = {};        // stato in memoria: nome tabella -> righe
  this.failNext = null;    // per simulare un guasto al prossimo query()
  this.errorHandlers = [];
}

FakePool.prototype.on = function (event, handler) {
  if (event === 'error') this.errorHandlers.push(handler);
};

FakePool.prototype.simulateFailure = function (errorMessage) {
  this.failNext = errorMessage;
};

FakePool.prototype.query = function (text, params) {
  var self = this;
  return new Promise(function (resolve, reject) {
    self.queries.push({ text: text, params: params || [] });

    if (self.failNext) {
      var msg = self.failNext;
      self.failNext = null;
      return reject(new Error(msg));
    }

    // interpretazione MINIMA delle query reali, sufficiente per i test:
    // non è un motore SQL, riconosce solo i pattern che il nostro codice
    // genera davvero (INSERT/UPSERT/SELECT su schema_migrations, upsert
    // su setups, insert su setup_events/analyses/logs).
    var t = text.trim();

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(t)) {
      self.tables.schema_migrations = self.tables.schema_migrations || [];
      return resolve({ rows: [] });
    }
    if (/^SELECT 1 FROM schema_migrations WHERE version/.test(t)) {
      var found = (self.tables.schema_migrations || []).filter(function (r) { return r.version === params[0]; });
      return resolve({ rows: found });
    }
    if (/^INSERT INTO schema_migrations/.test(t)) {
      self.tables.schema_migrations = self.tables.schema_migrations || [];
      self.tables.schema_migrations.push({ version: params[0] });
      return resolve({ rows: [] });
    }
    // Le vere CREATE TABLE / CREATE INDEX del file di migrazione: le
    // "eseguiamo" solo nel senso di accettarle senza errore.
    if (/^CREATE (TABLE|INDEX)/i.test(t) || t.indexOf('CREATE TABLE') !== -1) {
      return resolve({ rows: [] });
    }

    if (/^INSERT INTO setups/.test(t)) {
      self.tables.setups = self.tables.setups || {};
      var key = params[1] + '|' + params[0]; // symbol|id, stessa chiave composita dello schema reale
      var existing = self.tables.setups[key] || {};
      // simula il COALESCE: un valore nuovo non-null sovrascrive,
      // altrimenti resta quello già salvato — stessa logica della query reale
      var cols = ['id', 'symbol', 'direction', 'created_at', 'execution_mode', 'order_type', 'status',
        'bias', 'grade', 'confidence', 'entry_lo', 'entry_hi', 'sl', 'tp1', 'tp2', 'tp_fast', 'rr1', 'rr2', 'required_rr',
        'invalidation_level', 'atr_h1', 'atr_m15', 'market_structure', 'zones', 'quality_factors', 'reason', 'terminal_at', 'outcome'];
      var merged = Object.assign({}, existing);
      cols.forEach(function (col, i) {
        var v = params[i];
        if (v !== null && v !== undefined) merged[col] = v;
        else if (merged[col] === undefined) merged[col] = null;
      });
      self.tables.setups[key] = merged;
      return resolve({ rows: [merged] });
    }

    if (/^INSERT INTO setup_events/.test(t)) {
      self.tables.setup_events = self.tables.setup_events || [];
      self.tables.setup_events.push({
        setup_id: params[0], symbol: params[1], at: params[2], event_type: params[3],
        from_state: params[4], to_state: params[5], reason: params[6], payload: params[7]
      });
      return resolve({ rows: [] });
    }

    if (/^INSERT INTO analyses/.test(t)) {
      self.tables.analyses = self.tables.analyses || [];
      self.tables.analyses.push({
        symbol: params[0], at: params[1], price: params[2], bias: params[3], grade: params[4],
        confidence: params[5], execution_mode: params[6], decision: params[7], status: params[8], reason: params[9]
      });
      return resolve({ rows: [] });
    }

    if (/^INSERT INTO logs/.test(t)) {
      self.tables.logs = self.tables.logs || [];
      self.tables.logs.push({ at: params[0], level: params[1], component: params[2], event_type: params[3], message: params[4], context: params[5] });
      return resolve({ rows: [] });
    }

    if (/^INSERT INTO positions/.test(t)) {
      self.tables.positions = self.tables.positions || [];
      self.tables.positions.push({
        symbol: params[0], setup_id: params[1], direction: params[2], entry_price: params[3], sl: params[4],
        tp1: params[5], tp2: params[6], tp_fast: params[7], order_type: params[8], execution_mode: params[9],
        opened_at: params[10], status: params[11]
      });
      return resolve({ rows: [] });
    }

    if (/^UPDATE positions SET closed_at/.test(t)) {
      self.tables.positions = self.tables.positions || [];
      var posRow = self.tables.positions.find(function (r) {
        return r.symbol === params[4] && r.setup_id === params[5] && r.status === 'OPEN';
      });
      if (posRow) {
        posRow.closed_at = params[0]; posRow.exit_price = params[1]; posRow.exit_reason = params[2];
        posRow.pnl_r = params[3]; posRow.status = 'CLOSED';
      }
      return resolve({ rows: [] });
    }

    if (/^UPDATE setups SET terminal_at/.test(t)) {
      self.tables.setups = self.tables.setups || {};
      var key2 = params[4] + '|' + params[5];
      if (self.tables.setups[key2]) {
        self.tables.setups[key2].terminal_at = params[0];
        self.tables.setups[key2].outcome = params[1];
        self.tables.setups[key2].exit_price = params[2];
        self.tables.setups[key2].pnl_r = params[3];
      }
      return resolve({ rows: [] });
    }

    if (/^SELECT 1$/.test(t)) return resolve({ rows: [{ '?column?': 1 }] });

    return reject(new Error('Query non riconosciuta dal finto database: ' + t.slice(0, 80)));
  });
};

FakePool.prototype.end = function () { return Promise.resolve(); };

module.exports = { Pool: FakePool };
