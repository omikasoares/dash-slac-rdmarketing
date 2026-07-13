require('dotenv').config();

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');

const db = require('./lib/db');
const { runSync, enrichContactByEmail } = require('./lib/sync');

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES) || 30;

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
 * exato não é documentado publicamente — checa os formatos mais prováveis. */
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
    tags: row.tags ? JSON.parse(row.tags) : [],
    custom_fields: row.custom_fields ? JSON.parse(row.custom_fields) : {},
    events: row.events ? JSON.parse(row.events) : [],
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
    source: row.source,
  };
}

/* =========================
   SYNC EM SEGUNDO PLANO
========================= */
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

triggerSync();
setInterval(triggerSync, SYNC_INTERVAL_MINUTES * 60 * 1000);

/* =========================
   APP
========================= */
const app = express();

app.get('/healthz', (req, res) => res.send('ok'));

// Webhook de "Nova conversão" do RD Station (Conta > Integrações > Webhooks).
// Sem Basic Auth (o RD não envia credenciais) — protegido por um secret na
// própria URL. Não confiamos no conteúdo do payload em si (formato não é
// documentado publicamente); usamos só o email como sinal pra buscar os
// dados completos e atualizados direto na API.
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

app.get('/api/leads', (req, res) => {
  try {
    const leads = db.getAllContacts().map(parseContactRow);
    res.json(leads);
  } catch (e) {
    console.error('Erro ao listar leads:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/sync-status', (req, res) => {
  res.json({
    last_sync_at: db.getMeta('last_sync_at'),
    last_sync_duration_ms: Number(db.getMeta('last_sync_duration_ms')) || null,
    total_contacts: Number(db.getMeta('total_contacts')) || 0,
    syncing,
  });
});

app.post('/api/sync-now', (req, res) => {
  triggerSync();
  res.json({ triggered: true });
});

app.listen(PORT, () => {
  console.log(`Dashboard Slac (RD Marketing) rodando em http://localhost:${PORT}`);
});
