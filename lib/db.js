/**
 * Acesso ao Postgres (antes era SQLite local — migrado pra permitir sync
 * mais frequente sem depender de um arquivo em volume, e deixar o dado
 * pronto pra qualquer coisa que precise consultar direto, nao so essa app).
 *
 * tags / custom_fields / events / produtos_comprados sao colunas JSONB.
 * O driver `pg` ja devolve elas parseadas (array/objeto) na leitura — quem
 * grava ainda manda JSON.stringify(...), o Postgres aceita o texto e
 * valida/converte pra jsonb no INSERT/UPDATE.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** O Postgres pode ainda nao estar de pe quando o app sobe (Swarm nao
 * garante ordem entre servicos) — tenta por ate ~30s antes de desistir. */
async function withRetry(fn, { retries = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) throw e;
      console.warn(`Postgres indisponível (tentativa ${attempt}/${retries}), tentando de novo em ${delayMs}ms:`, e.message);
      await sleep(delayMs);
    }
  }
}

async function init() {
  await withRetry(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        uuid TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        personal_phone TEXT,
        mobile_phone TEXT,
        tags JSONB,
        lifecycle_stage TEXT,
        origin TEXT,
        created_at TEXT,
        last_conversion_date TEXT,
        custom_fields JSONB,
        events JSONB,
        synced_last_conversion_date TEXT,
        last_synced_at TEXT,
        public_url TEXT,
        owner_email TEXT,
        total_conversions INTEGER,
        first_conversion_date TEXT,
        first_conversion_origin TEXT,
        last_opportunity_date TEXT,
        last_sale_date TEXT,
        last_sale_value TEXT,
        events_summary_raw TEXT,
        source TEXT,
        id_crm TEXT,
        consultor TEXT,
        canal_sheet TEXT,
        tipo_trafego_sheet TEXT,
        publico_sheet TEXT,
        criativo_sheet TEXT,
        posicao_anuncio_sheet TEXT,
        campanha_converteu_sheet TEXT,
        falado TEXT,
        tabulacao_perda TEXT,
        observacao_comercial TEXT,
        fluxo_mensagens TEXT,
        numero_contatos_estimado INTEGER,
        produtos_comprados JSONB,
        sheet_tab_origem TEXT,
        sheet_data_interacao TEXT,
        sheet_last_synced_at TEXT,
        email_status_ativo BOOLEAN
      );

      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `)
  );

  // Migracao leve, idempotente — cobre o caso de reaproveitar um banco
  // criado antes dessa coluna existir.
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_status_ativo BOOLEAN`);

  // Preenche id_crm a partir do custom_fields (cf_id_crm) pra quem ainda
  // nao tem — permite join rapido com a planilha de CRM sem acessar o
  // JSONB a cada consulta.
  await pool.query(`
    UPDATE contacts
    SET id_crm = custom_fields->>'cf_id_crm'
    WHERE id_crm IS NULL AND custom_fields ? 'cf_id_crm'
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_id_crm ON contacts(id_crm)`);
}

const initPromise = init().catch((e) => {
  console.error('Falha ao inicializar o schema do Postgres:', e);
  process.exit(1);
});

async function ready() {
  await initPromise;
}

async function upsertContactIndex(row) {
  await ready();
  await pool.query(
    `INSERT INTO contacts (uuid, name, email, created_at, last_conversion_date, source)
     VALUES ($1, $2, $3, $4, $5, 'api')
     ON CONFLICT (uuid) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       last_conversion_date = EXCLUDED.last_conversion_date,
       created_at = COALESCE(contacts.created_at, EXCLUDED.created_at)`,
    [row.uuid, row.name, row.email, row.created_at, row.last_conversion_date]
  );
}

async function upsertContactDetail(row) {
  await ready();
  await pool.query(
    `UPDATE contacts SET
       personal_phone = $2,
       mobile_phone = $3,
       tags = $4::jsonb,
       lifecycle_stage = $5,
       origin = $6,
       custom_fields = $7::jsonb,
       events = $8::jsonb,
       produtos_comprados = $9::jsonb,
       synced_last_conversion_date = $10,
       last_synced_at = $11,
       id_crm = COALESCE(id_crm, $12)
     WHERE uuid = $1`,
    [
      row.uuid,
      row.personal_phone,
      row.mobile_phone,
      row.tags,
      row.lifecycle_stage,
      row.origin,
      row.custom_fields,
      row.events,
      row.produtos_comprados,
      row.synced_last_conversion_date,
      row.last_synced_at,
      row.id_crm,
    ]
  );
}

/** Roda `fn(client)` dentro de uma unica transacao. Uso: bulk insert do
 * import-csv.js — sem isso seria um commit por linha, lento demais pra
 * dezenas de milhares de linhas num Postgres remoto. */
async function withTransaction(fn) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Bootstrap a partir da exportacao CSV do RD Station: popula todos os
 * campos que o export traz de graca, mas NAO marca synced_last_conversion_date
 * — assim o sync em segundo plano ainda busca o historico detalhado de
 * conversao (com atribuicao de trafego) na proxima rodada, como se fosse um
 * contato novo. Aceita um client opcional (pra rodar dentro de uma
 * withTransaction em lote); usa o pool direto se nao for passado. */
async function upsertContactFromCsv(row, client = pool) {
  await ready();
  await client.query(
    `INSERT INTO contacts (
       uuid, name, email, personal_phone, mobile_phone, tags, lifecycle_stage,
       origin, last_conversion_date, custom_fields, public_url, owner_email,
       total_conversions, first_conversion_date, first_conversion_origin,
       last_opportunity_date, last_sale_date, last_sale_value, events_summary_raw,
       produtos_comprados, source, id_crm, email_status_ativo
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7,
       $8, $9, $10::jsonb, $11, $12,
       $13, $14, $15,
       $16, $17, $18, $19,
       $20::jsonb, 'csv_import', $21, $22
     )
     ON CONFLICT (uuid) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       personal_phone = EXCLUDED.personal_phone,
       mobile_phone = EXCLUDED.mobile_phone,
       tags = EXCLUDED.tags,
       lifecycle_stage = EXCLUDED.lifecycle_stage,
       origin = EXCLUDED.origin,
       last_conversion_date = EXCLUDED.last_conversion_date,
       custom_fields = EXCLUDED.custom_fields,
       public_url = EXCLUDED.public_url,
       owner_email = EXCLUDED.owner_email,
       total_conversions = EXCLUDED.total_conversions,
       first_conversion_date = EXCLUDED.first_conversion_date,
       first_conversion_origin = EXCLUDED.first_conversion_origin,
       last_opportunity_date = EXCLUDED.last_opportunity_date,
       last_sale_date = EXCLUDED.last_sale_date,
       last_sale_value = EXCLUDED.last_sale_value,
       events_summary_raw = EXCLUDED.events_summary_raw,
       produtos_comprados = COALESCE(EXCLUDED.produtos_comprados, contacts.produtos_comprados),
       id_crm = COALESCE(contacts.id_crm, EXCLUDED.id_crm),
       email_status_ativo = EXCLUDED.email_status_ativo`,
    [
      row.uuid,
      row.name,
      row.email,
      row.personal_phone,
      row.mobile_phone,
      row.tags,
      row.lifecycle_stage,
      row.origin,
      row.last_conversion_date,
      row.custom_fields,
      row.public_url,
      row.owner_email,
      row.total_conversions,
      row.first_conversion_date,
      row.first_conversion_origin,
      row.last_opportunity_date,
      row.last_sale_date,
      row.last_sale_value,
      row.events_summary_raw,
      row.produtos_comprados,
      row.id_crm,
      row.email_status_ativo,
    ]
  );
}

async function getContactByUuid(uuid) {
  await ready();
  const { rows } = await pool.query('SELECT * FROM contacts WHERE uuid = $1', [uuid]);
  return rows[0];
}

async function getAllContacts() {
  await ready();
  const { rows } = await pool.query('SELECT * FROM contacts ORDER BY last_conversion_date DESC NULLS LAST');
  return rows;
}

async function countContacts() {
  await ready();
  const { rows } = await pool.query('SELECT COUNT(*) AS total FROM contacts');
  return Number(rows[0].total);
}

async function setMeta(key, value) {
  await ready();
  await pool.query(
    'INSERT INTO sync_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

async function getMeta(key) {
  await ready();
  const { rows } = await pool.query('SELECT value FROM sync_meta WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

/** Mapa {id_crm -> uuid} pra join rapido com a planilha de CRM (uma query so). */
async function getIdCrmMap() {
  await ready();
  const { rows } = await pool.query('SELECT uuid, id_crm FROM contacts WHERE id_crm IS NOT NULL');
  const map = new Map();
  for (const row of rows) map.set(row.id_crm, row.uuid);
  return map;
}

async function upsertSheetData(row) {
  await ready();
  await pool.query(
    `UPDATE contacts SET
       consultor = $2,
       canal_sheet = $3,
       tipo_trafego_sheet = $4,
       publico_sheet = $5,
       criativo_sheet = $6,
       posicao_anuncio_sheet = $7,
       campanha_converteu_sheet = $8,
       falado = $9,
       tabulacao_perda = $10,
       observacao_comercial = $11,
       fluxo_mensagens = $12,
       numero_contatos_estimado = $13,
       sheet_tab_origem = $14,
       sheet_data_interacao = $15,
       sheet_last_synced_at = $16
     WHERE uuid = $1`,
    [
      row.uuid,
      row.consultor,
      row.canal_sheet,
      row.tipo_trafego_sheet,
      row.publico_sheet,
      row.criativo_sheet,
      row.posicao_anuncio_sheet,
      row.campanha_converteu_sheet,
      row.falado,
      row.tabulacao_perda,
      row.observacao_comercial,
      row.fluxo_mensagens,
      row.numero_contatos_estimado,
      row.sheet_tab_origem,
      row.sheet_data_interacao,
      row.sheet_last_synced_at,
    ]
  );
}

module.exports = {
  upsertContactIndex,
  upsertContactDetail,
  upsertContactFromCsv,
  withTransaction,
  getIdCrmMap,
  upsertSheetData,
  getContactByUuid,
  getAllContacts,
  countContacts,
  setMeta,
  getMeta,
};
