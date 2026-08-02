-- ══════════════════════════════════════════════════════════════════
-- MIGRAZIONE 003 — decisioni bloccate.
--
-- Registra ogni setup che il Decision Gate ha impedito di operare, con
-- il motivo, e — quando il motore lo rivela — come sarebbe andato.
--
-- È la base per rispondere con dati oggettivi a: "questo filtro mi sta
-- proteggendo o mi sta togliendo occasioni?". Senza questa tabella,
-- ogni filtro presente e futuro resterebbe una scommessa non
-- verificabile.
--
-- Nota sull'esito: WOULD_HIT_TP / WOULD_HIT_SL sono ESITI IPOTETICI,
-- osservati dai segnali che il motore emette comunque anche per i setup
-- bloccati. Non sono trade reali e non vanno mai mescolati con la
-- tabella positions, che contiene solo operazioni davvero avvenute.

CREATE TABLE IF NOT EXISTS blocked_decisions (
  id             BIGSERIAL PRIMARY KEY,
  symbol         TEXT NOT NULL,
  setup_id       TEXT NOT NULL,
  direction      TEXT,

  blocked_at     TIMESTAMPTZ NOT NULL,
  blocked_by     TEXT NOT NULL,        -- news | risk (e in futuro altri filtri)
  block_reason   TEXT,

  -- livelli del piano al momento del blocco, per calcolare l'esito in R
  entry          NUMERIC,
  sl             NUMERIC,
  tp1            NUMERIC,
  grade          TEXT,
  confidence     NUMERIC,
  execution_mode TEXT,

  -- esito ipotetico, valorizzato quando il motore lo rivela
  resolved_at    TIMESTAMPTZ,
  outcome        TEXT,                 -- WOULD_HIT_TP | WOULD_HIT_SL | EXPIRED
  exit_price     NUMERIC,
  hypothetical_r NUMERIC,

  UNIQUE (symbol, setup_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_by ON blocked_decisions (blocked_by);
CREATE INDEX IF NOT EXISTS idx_blocked_outcome ON blocked_decisions (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocked_at ON blocked_decisions (blocked_at DESC);
