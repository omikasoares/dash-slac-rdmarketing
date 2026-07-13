/**
 * Cliente de leitura da planilha de CRM/comercial (Google Sheets), mantida
 * manualmente pelo time de vendas do cliente Slac (uma aba por mês).
 */
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error('Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (.env) antes de usar o sheets-client.');
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

/** Lista as abas (nome) da planilha. */
async function listSheetTabs(spreadsheetId) {
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

/** Lê todas as linhas de uma aba (values.get, formato bruto). */
async function getSheetValues(spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'`,
  });
  return res.data.values || [];
}

module.exports = { listSheetTabs, getSheetValues };
