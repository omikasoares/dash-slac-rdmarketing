const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './data/leads.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    uuid TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    personal_phone TEXT,
    mobile_phone TEXT,
    tags TEXT,
    lifecycle_stage TEXT,
    origin TEXT,
    created_at TEXT,
    last_conversion_date TEXT,
    custom_fields TEXT,
    events TEXT,
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
    falado TEXT,
    tabulacao_perda TEXT,
    observacao_comercial TEXT,
    fluxo_mensagens TEXT,
    sheet_tab_origem TEXT,
    sheet_data_interacao TEXT,
    sheet_last_synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migração leve para bancos criados antes dessas colunas existirem.
const NEW_COLUMNS = [
  ['public_url', 'TEXT'],
  ['owner_email', 'TEXT'],
  ['total_conversions', 'INTEGER'],
  ['first_conversion_date', 'TEXT'],
  ['first_conversion_origin', 'TEXT'],
  ['last_opportunity_date', 'TEXT'],
  ['last_sale_date', 'TEXT'],
  ['last_sale_value', 'TEXT'],
  ['events_summary_raw', 'TEXT'],
  ['source', 'TEXT'],
  ['id_crm', 'TEXT'],
  ['consultor', 'TEXT'],
  ['canal_sheet', 'TEXT'],
  ['tipo_trafego_sheet', 'TEXT'],
  ['publico_sheet', 'TEXT'],
  ['criativo_sheet', 'TEXT'],
  ['posicao_anuncio_sheet', 'TEXT'],
  ['falado', 'TEXT'],
  ['tabulacao_perda', 'TEXT'],
  ['observacao_comercial', 'TEXT'],
  ['fluxo_mensagens', 'TEXT'],
  ['sheet_tab_origem', 'TEXT'],
  ['sheet_data_interacao', 'TEXT'],
  ['sheet_last_synced_at', 'TEXT'],
];
for (const [col, type] of NEW_COLUMNS) {
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${type}`);
  } catch (e) {
    // coluna já existe
  }
}

// Preenche id_crm a partir do custom_fields (cf_id_crm) pra contatos que
// ainda não têm — permite join rápido com a planilha de CRM sem parsear
// JSON a cada consulta.
db.exec(`
  UPDATE contacts
  SET id_crm = json_extract(custom_fields, '$.cf_id_crm')
  WHERE id_crm IS NULL AND custom_fields IS NOT NULL AND json_extract(custom_fields, '$.cf_id_crm') IS NOT NULL
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_id_crm ON contacts(id_crm)');

const upsertIndexStmt = db.prepare(`
  INSERT INTO contacts (uuid, name, email, created_at, last_conversion_date, source)
  VALUES (@uuid, @name, @email, @created_at, @last_conversion_date, 'api')
  ON CONFLICT(uuid) DO UPDATE SET
    name = excluded.name,
    email = excluded.email,
    last_conversion_date = excluded.last_conversion_date,
    created_at = COALESCE(contacts.created_at, excluded.created_at)
`);

const upsertDetailStmt = db.prepare(`
  UPDATE contacts SET
    personal_phone = @personal_phone,
    mobile_phone = @mobile_phone,
    tags = @tags,
    lifecycle_stage = @lifecycle_stage,
    origin = @origin,
    custom_fields = @custom_fields,
    events = @events,
    synced_last_conversion_date = @synced_last_conversion_date,
    last_synced_at = @last_synced_at,
    id_crm = COALESCE(id_crm, @id_crm)
  WHERE uuid = @uuid
`);

// Bootstrap a partir da exportação CSV do RD Station: popula todos os campos
// que o export traz de graça, mas NÃO marca synced_last_conversion_date —
// assim o sync em segundo plano ainda busca o histórico de eventos detalhado
// (com atribuição de tráfego por conversão) na próxima rodada, como se fosse
// um contato novo.
const upsertFromCsvStmt = db.prepare(`
  INSERT INTO contacts (
    uuid, name, email, personal_phone, mobile_phone, tags, lifecycle_stage,
    origin, last_conversion_date, custom_fields, public_url, owner_email,
    total_conversions, first_conversion_date, first_conversion_origin,
    last_opportunity_date, last_sale_date, last_sale_value, events_summary_raw,
    source, id_crm
  ) VALUES (
    @uuid, @name, @email, @personal_phone, @mobile_phone, @tags, @lifecycle_stage,
    @origin, @last_conversion_date, @custom_fields, @public_url, @owner_email,
    @total_conversions, @first_conversion_date, @first_conversion_origin,
    @last_opportunity_date, @last_sale_date, @last_sale_value, @events_summary_raw,
    'csv_import', @id_crm
  )
  ON CONFLICT(uuid) DO UPDATE SET
    name = excluded.name,
    email = excluded.email,
    personal_phone = excluded.personal_phone,
    mobile_phone = excluded.mobile_phone,
    tags = excluded.tags,
    lifecycle_stage = excluded.lifecycle_stage,
    origin = excluded.origin,
    last_conversion_date = excluded.last_conversion_date,
    custom_fields = excluded.custom_fields,
    public_url = excluded.public_url,
    owner_email = excluded.owner_email,
    total_conversions = excluded.total_conversions,
    first_conversion_date = excluded.first_conversion_date,
    first_conversion_origin = excluded.first_conversion_origin,
    last_opportunity_date = excluded.last_opportunity_date,
    last_sale_date = excluded.last_sale_date,
    last_sale_value = excluded.last_sale_value,
    events_summary_raw = excluded.events_summary_raw,
    id_crm = COALESCE(contacts.id_crm, excluded.id_crm)
`);

function upsertContactIndex(row) {
  upsertIndexStmt.run(row);
}

function upsertContactDetail(row) {
  upsertDetailStmt.run(row);
}

function upsertContactFromCsv(row) {
  upsertFromCsvStmt.run(row);
}

function getContactByUuid(uuid) {
  return db.prepare('SELECT * FROM contacts WHERE uuid = ?').get(uuid);
}

function getAllContacts() {
  return db.prepare('SELECT * FROM contacts ORDER BY last_conversion_date DESC').all();
}

function countContacts() {
  return db.prepare('SELECT COUNT(*) AS total FROM contacts').get().total;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Mapa {id_crm -> uuid} pra join rápido com a planilha de CRM (uma query só). */
function getIdCrmMap() {
  const rows = db.prepare('SELECT uuid, id_crm FROM contacts WHERE id_crm IS NOT NULL').all();
  const map = new Map();
  for (const row of rows) map.set(row.id_crm, row.uuid);
  return map;
}

const upsertSheetDataStmt = db.prepare(`
  UPDATE contacts SET
    consultor = @consultor,
    canal_sheet = @canal_sheet,
    tipo_trafego_sheet = @tipo_trafego_sheet,
    publico_sheet = @publico_sheet,
    criativo_sheet = @criativo_sheet,
    posicao_anuncio_sheet = @posicao_anuncio_sheet,
    falado = @falado,
    tabulacao_perda = @tabulacao_perda,
    observacao_comercial = @observacao_comercial,
    fluxo_mensagens = @fluxo_mensagens,
    sheet_tab_origem = @sheet_tab_origem,
    sheet_data_interacao = @sheet_data_interacao,
    sheet_last_synced_at = @sheet_last_synced_at
  WHERE uuid = @uuid
`);

function upsertSheetData(row) {
  upsertSheetDataStmt.run(row);
}

module.exports = {
  upsertContactIndex,
  upsertContactDetail,
  upsertContactFromCsv,
  getIdCrmMap,
  upsertSheetData,
  getContactByUuid,
  getAllContacts,
  countContacts,
  setMeta,
  getMeta,
};
