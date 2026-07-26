require('dotenv').config();

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');

const db = require('./lib/db');
const { enrichContactByEmail } = require('./lib/sync');
const { runSheetSync } = require('./lib/sheets-sync');

const PORT = process.env.PORT || 3000;

// Sync do RD Station (paginação em massa da segmentação): roda no n8n
// ("SLAC - Sync RD Station", a cada 15min), não aqui — evita dois processos
// disputando o limite de 120 req/min da conta RD Station. Esse app só faz
// enriquecimento pontual via webhook de nova conversão (abaixo).
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

app.listen(PORT, () => {
  console.log(`Dashboard Slac (RD Marketing) rodando em http://localhost:${PORT}`);
});
