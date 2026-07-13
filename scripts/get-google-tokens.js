/**
 * Rodar UMA VEZ localmente para obter o GOOGLE_REFRESH_TOKEN (acesso de
 * leitura à planilha de CRM/comercial no Google Sheets).
 *
 * Pré-requisito: criar (ou reaproveitar) um projeto no Google Cloud Console
 * com a Google Sheets API ativada, e um OAuth Client ID do tipo "Desktop app".
 * Copie o Client ID/Secret pra GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET no .env.
 *
 * Uso:
 *   npm run get-google-tokens
 *
 * Abre uma URL de consentimento do Google; após autorizar com a conta dona
 * (ou com acesso de leitura) da planilha, o refresh token é impresso no
 * terminal. Copie o valor para GOOGLE_REFRESH_TOKEN.
 */
require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 4569;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (env ou .env) antes de rodar este script.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\nAbra esta URL no navegador (logado com a conta que tem acesso à planilha) e autorize:\n');
console.log(authUrl);
console.log(`\nAguardando callback em ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/')) return;
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Faltou o parâmetro "code".');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorizado!</h1><p>Pode fechar esta aba e voltar pro terminal.</p>');

    console.log('Refresh token obtido com sucesso:\n');
    console.log(tokens.refresh_token);
    console.log('\nSalve esse valor como GOOGLE_REFRESH_TOKEN.\n');
  } catch (e) {
    res.writeHead(500).end('Erro ao trocar o code por tokens: ' + e.message);
    console.error('Erro ao trocar o code por tokens:', e.message);
  } finally {
    server.close(() => process.exit(0));
  }
});

server.listen(PORT);
