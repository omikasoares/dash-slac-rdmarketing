require('dotenv').config();

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');

const db = require('./lib/db');
const { runSync, enrichContactByEmail } = require('./lib/sync');
const { runSheetSync } = require('./lib/sheets-sync');

const PORT = process.env.PORT || 3000;

// Sync do RD Station: intervalo curto em horario comercial, mais espacado
// fora dele. Tudo em America/Sao_Paulo via Intl (nao depende do TZ do SO/
// tzdata da imagem, funciona igual em qualquer container).
const SYNC_TZ = 'America/Sao_Paulo';
const SYNC_BUSINESS_START = process.env.SYNC_BUSINESS_START || '07:50';
const SYNC_BUSINESS_END = process.env.SYNC_BUSINESS_END || '19:00';
const SYNC_INTERVAL_BUSINESS_MINUTES = Number(process.env.SYNC_INTERVAL_BUSINESS_MINUTES) || 5;
const SYNC_INTERVAL_OFFHOURS_MINUTES = Number(process.env.SYNC_INTERVAL_OFFHOURS_MINUTES) || 60;

const SHEET_SYNC_INTERVAL_MINUTES = Number(process.env.SHEET_SYNC_INTERVAL_MINUTES) || 15;

const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
  throw new Error('Defina DASHBOARD_USER e DASHBOARD_PASSWORD (.env) — o dashboard expõe dados pessoais de leads.');
}
if (!WEBHOOK_SECRET) {
  throw new Error('Defina WEBHOOK_SECRET (.env) — protege a URL do webhook de nova conversão do RD Station.');
}

/** Tenta extrair o email do payload do webhook do RD Station, cujo formato
 * exato nao e documentado publicamente — checa os formatos mais provaveis. */
function extractEmailFromWebhookBody(body) {
  return (
    body?.email ||
    body?.contact?.email ||
    body?.lead?.email ||
    body?.leads?.[0]?.email ||
    null
  );
}

function parseContactRow(row) {
  // tags / custom_fields / events / produtos_comprados sao JSONB no Postgres
  // — o driver `pg` ja devolve array/objeto parseado, sem JSON.parse aqui.
  const customFields = row.custom_fields || {};
  return {
    uuid: row.uuid,
    name: row.name,
    email: row.email,
    personal_phone: row.personal_phone,
    mobile_phone: row.mobile_phone,
    created_at: row.created_at,
    last_conversion_date: row.last_conversion_date,
    lifecycle_stage: row.lifecycle_stage,
    origin: row.origin,
    tags: row.tags || [],
    custom_fields: customFields,
    events: row.events || [],
    last_synced_at: row.last_synced_at,
    public_url: row.public_url,
    owner_email: row.owner_email,
    total_conversions: row.total_conversions,
    first_conversion_date: row.first_conversion_date,
    first_conversion_origin: row.first_conversion_origin,
    last_opportunity_date: row.last_opportunity_date,
    last_sale_date: row.last_sale_date,
    last_sale_value: row.last_sale_value,
    events_summary_raw: row.events_summary_raw,
    produtos_comprados: row.produtos_comprados || [],
    source: row.source,
    id_crm: row.id_crm,
    consultor: row.consultor,
    canal_sheet: row.canal_sheet,
    tipo_trafego_sheet: row.tipo_trafego_sheet,
    publico_sheet: row.publico_sheet,
    criativo_sheet: row.criativo_sheet,
    posicao_anuncio_sheet: row.posicao_anuncio_sheet,
    campanha_converteu_sheet: row.campanha_converteu_sheet,
    falado: row.falado,
    tabulacao_perda: row.tabulacao_perda,
    observacao_comercial: row.observacao_comercial,
    fluxo_mensagens: row.fluxo_mensagens,
    numero_contatos_estimado: row.numero_contatos_estimado,
    sheet_tab_origem: row.sheet_tab_origem,
    sheet_data_interacao: row.sheet_data_interacao,
    sheet_last_synced_at: row.sheet_last_synced_at,
    email_status_ativo: row.email_status_ativo,
    canal_resolvido: customFields.cf_utm_source || row.canal_sheet || null,
    campanha_resolvida: customFields.cf_utm_campaign || row.campanha_converteu_sheet || null,
    criativo_resolvido: customFields.cf_utm_content || row.criativo_sheet || null,
    publico_resolvido: customFields.cf_utm_term || row.publico_sheet || null,
  };
}

let syncing = false;
async function triggerSync() {
  if (syncing) return;
  syncing = true;
  try {
    await runSync();
  } catch (e) {
    console.error('Erro no sync:', e);
  } finally {
    syncing = false;
  }
}

/** Minutos desde meia-noite, no fuso informado, sem depender de TZ do SO. */
function nowMinutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function parseHHMM(str) {
  const [h, m] = String(str).split(':').map(Number);
  return h * 60 + (m || 0);
}

const businessStartMin = parseHHMM(SYNC_BUSINESS_START);
const businessEndMin = parseHHMM(SYNC_BUSINESS_END);

function isBusinessHours() {
  const mins = nowMinutesInTz(SYNC_TZ);
  return mins >= businessStartMin && mins < businessEndMin;
}

function scheduleNextSync() {
  const intervalMinutes = isBusinessHours() ? SYNC_INTERVAL_BUSINESS_MINUTES : SYNC_INTERVAL_OFFHOURS_MINUTES;
  setTimeout(async () => {
    await triggerSync();
    scheduleNextSync();
  }, intervalMinutes * 60 * 1000);
}

triggerSync();
scheduleNextSync();

let syncingSheet = false;
async function triggerSheetSync() {
  if (syncingSheet) return;
  syncingSheet = true;
  try {
    await runSheetSync();
  } catch (e) {
    console.error('Erro no sync da planilha:', e);
  } finally {
    syncingSheet = false;
  }
}

triggerSheetSync();
setInterval(triggerSheetSync, SHEET_SYNC_INTERVAL_MINUTES * 60 * 1000);

const app = express();

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/webhook/rd-conversion/:secret', express.json(), async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET) {
    return res.status(404).end();
  }

  const email = extractEmailFromWebhookBody(req.body);
  if (!email) {
    console.warn('Webhook recebido sem email identificável. Payload:', JSON.stringify(req.body));
    return res.status(400).json({ message: 'Não foi possível identificar o email do contato no payload.' });
  }

  try {
    const uuid = await enrichContactByEmail(email);
    res.json({ ok: true, uuid });
  } catch (e) {
    console.error(`Erro ao enriquecer contato via webhook (${email}):`, e.message);
    res.status(502).json({ message: e.message });
  }
});

app.use(
  basicAuth({
    users: { [DASHBOARD_USER]: DASHBOARD_PASSWORD },
    challenge: true,
    realm: 'dash-slac-rdmarketing',
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/leads', async (req, res) => {
  try {
    const rows = await db.getAllContacts();
    res.json(rows.map(parseContactRow));
  } catch (e) {
    console.error('Erro ao listar leads:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/sync-status', async (req, res) => {
  try {
    const [
      lastSyncAt,
      lastSyncDurationMs,
      totalContacts,
      sheetLastSyncAt,
      sheetLastSyncMatched,
      sheetLastSyncNotFound,
      sheetLastSyncInvalidId,
    ] = await Promise.all([
      db.getMeta('last_sync_at'),
      db.getMeta('last_sync_duration_ms'),
      db.getMeta('total_contacts'),
      db.getMeta('sheet_last_sync_at'),
      db.getMeta('sheet_last_sync_matched'),
      db.getMeta('sheet_last_sync_not_found'),
      db.getMeta('sheet_last_sync_invalid_id'),
    ]);

    res.json({
      last_sync_at: lastSyncAt,
      last_sync_duration_ms: Number(lastSyncDurationMs) || null,
      total_contacts: Number(totalContacts) || 0,
      syncing,
      sheet_last_sync_at: sheetLastSyncAt,
      sheet_last_sync_matched: Number(sheetLastSyncMatched) || 0,
      sheet_last_sync_not_found: Number(sheetLastSyncNotFound) || 0,
      sheet_last_sync_invalid_id: Number(sheetLastSyncInvalidId) || 0,
      syncingSheet,
    });
  } catch (e) {
    console.error('Erro ao ler status de sync:', e);
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/sync-now', (req, res) => {
  triggerSync();
  res.json({ triggered: true });
});

app.listen(PORT, () => {
  console.log(`Dashboard Slac (RD Marketing) rodando em http://localhost:${PORT}`);
});
