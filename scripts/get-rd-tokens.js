/**
 * Rodar UMA VEZ localmente para obter o RD_REFRESH_TOKEN.
 *
 * Pré-requisito: criar um aplicativo na RD Station App Store
 * (https://developers.rdstation.com/reference/criar-aplicativo-appstore)
 * e cadastrar a Callback URL EXATAMENTE igual ao valor de RD_REDIRECT_URI
 * abaixo (padrão: http://127.0.0.1:4568).
 *
 * Uso:
 *   Preencha RD_CLIENT_ID / RD_CLIENT_SECRET no .env e rode:
 *   npm run get-rd-tokens
 *
 * Abre a URL de autorização do RD Station; após autorizar, o code é trocado
 * por access_token/refresh_token e o refresh_token é impresso no terminal.
 * Copie o valor para o secret RD_REFRESH_TOKEN (GitHub Actions / .env da VPS).
 */
require('dotenv').config();
const http = require('http');

const CLIENT_ID = process.env.RD_CLIENT_ID;
const CLIENT_SECRET = process.env.RD_CLIENT_SECRET;
const PORT = 4568;
const REDIRECT_URI = process.env.RD_REDIRECT_URI || `http://127.0.0.1:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Defina RD_CLIENT_ID e RD_CLIENT_SECRET (env ou .env) antes de rodar este script.');
  process.exit(1);
}

const authUrl = `https://api.rd.services/auth/dialog?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

console.log('\nAbra esta URL no navegador (logado na conta RD Station do cliente Slac) e autorize:\n');
console.log(authUrl);
console.log(`\nAguardando callback em ${REDIRECT_URI} ...\n`);
console.log('Se o RD Station rejeitar a Callback URL, confirme que ela está cadastrada');
console.log('EXATAMENTE assim no aplicativo da App Store (ou ajuste RD_REDIRECT_URI no .env).\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Faltou o parâmetro "code".');
    return;
  }

  try {
    const tokenRes = await fetch(`https://api.rd.services/auth/token?token_by=code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(JSON.stringify(tokens));
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorizado!</h1><p>Pode fechar esta aba e voltar pro terminal.</p>');

    console.log('Tokens obtidos com sucesso:\n');
    console.log('access_token (válido 24h):', tokens.access_token);
    console.log('\nrefresh_token (não expira):\n');
    console.log(tokens.refresh_token);
    console.log('\nSalve esse valor como RD_REFRESH_TOKEN.\n');
  } catch (e) {
    res.writeHead(500).end('Erro ao trocar o code por tokens: ' + e.message);
    console.error('Erro ao trocar o code por tokens:', e.message);
  } finally {
    server.close(() => process.exit(0));
  }
});

server.listen(PORT);
