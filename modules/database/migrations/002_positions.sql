-- ══════════════════════════════════════════════════════════════════
-- MIGRAZIONE 002 — tabella positions.
--
-- PERCHÉ SEPARATA DA "setups": la tabella setups viene aggiornata a
-- ogni ciclo con i valori PIÙ RECENTI del piano (entry/SL/TP possono
-- cambiare mentre il motore rivaluta la stessa opportunità in stati di
-- attesa) — è un log evolutivo del "cosa pensa il motore ora".
--
-- "positions" invece è il registro AUTOREVOLE di cosa è REALMENTE
-- successo come operazione: entry/SL/TP fissati per sempre al momento
-- dell'apertura (mai più toccati, stesso principio di immutabilità già
-- verificato per il target del motore), e uscita/guadagno scritti una
-- sola volta alla chiusura. Necessaria per calcolare winrate/profit
-- factor senza il rischio che i numeri "si muovano" nel tempo.

CREATE TABLE IF NOT EXISTS positions (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  setup_id      TEXT NOT NULL,
  direction     TEXT NOT NULL,

  entry_price   NUMERIC NOT NULL,
  sl            NUMERIC NOT NULL,
  tp1           NUMERIC,
  tp2           NUMERIC,             -- informativo: mai un vero target di uscita (vedi positionTracker)
  tp_fast       NUMERIC,
  order_type    TEXT,
  execution_mode TEXT,

  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ,
  exit_price    NUMERIC,
  exit_reason   TEXT,                -- SL | TP1
  pnl_r         NUMERIC,             -- guadagno/perdita in multipli di R, stessa formula del backtest

  status        TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED

  FOREIGN KEY (symbol, setup_id) REFERENCES setups (symbol, id)
);

CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions (symbol, status);
CREATE INDEX IF NOT EXISTS idx_positions_setup ON positions (symbol, setup_id);
CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON positions (closed_at DESC) WHERE closed_at IS NOT NULL;
