require('dotenv').config();

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');

const PORT = process.env.PORT || 3000;

const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
  throw new Error('Defina DASHBOARD_USER e DASHBOARD_PASSWORD (.env) — o dashboard expõe dados pessoais de leads.');
}

// Sync do RD Station, da planilha de CRM e enriquecimento de nova conversão
// rodam todos no n8n agora (workflows "SLAC - Sync RD Station", "SLAC - Sync
// Planilha CRM", "SLAC - Webhook Nova Conversao"). Esse app só serve o
// front-end estático atrás de Basic Auth — o front busca os dados direto
// dos webhooks do n8n, sem passar por aqui.
const app = express();

app.get('/healthz', (req, res) => res.send('ok'));

app.use(
  basicAuth({
    users: { [DASHBOARD_USER]: DASHBOARD_PASSWORD },
    challenge: true,
    realm: 'dash-slac-rdmarketing',
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Dashboard Slac (RD Marketing) rodando em http://localhost:${PORT}`);
});
