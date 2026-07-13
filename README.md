# Dashboard de Leads — Slac (RD Station Marketing)

Dashboard que consolida os leads do RD Station Marketing (RDSM) da conta do
cliente Slac num painel único e pesquisável, sincronizando os dados em
segundo plano num banco SQLite local (evita bater na API do RD a cada
carregamento de página).

## Escopo (v1)

Só dados do **RD Station Marketing**: nome, email, telefones, tags, custom
fields, data de criação, data da última conversão, histórico de conversão
(iscas/formulários) com atribuição de tráfego (canal/campanha/criativo) e
estágio no funil (Lead/Oportunidade/Cliente).

A exportação de contatos do próprio RD Station ("Contatos > Exportar") traz
de graça, além disso: estágio no funil, data/valor da última venda e
oportunidade, dono do lead, total de conversões e um resumo bruto dos
últimos 100 eventos. `scripts/import-csv.js` faz bootstrap do SQLite a
partir desse export — útil porque a base é grande (dezenas de milhares de
contatos) e o primeiro sync via API, contato por contato, demoraria muito.

**Vem da planilha de CRM/comercial** (Google Sheets, sincronizada a cada
`SHEET_SYNC_INTERVAL_MINUTES`, ver seção abaixo): consultor responsável,
falado/não falado, tabulação de perda, canal/tipo de tráfego/público/criativo
(quando presente na aba) e observações do atendimento comercial.

**Ainda fora do escopo** (não encontrado em nenhuma fonte disponível):
produto comprado, número de ligações/mensagens como contagem limpa (só como
texto livre na observação), e histórico de mensagens WhatsApp.

**Limitação conhecida da API do RD Station Marketing**: não existe endpoint
de histórico de e-mail (abertura/clique) por contato individual — só
analytics agregado por campanha/workflow. Isso é uma limitação da API, não
do dashboard.

## Planilha de CRM/comercial (Google Sheets)

O time de vendas mantém uma planilha própria (uma aba por mês, ex. "Junho
2026", "Julho 2026") com o acompanhamento de ligações/tabulação de cada
lead. `lib/sheets-sync.js` lê todas as abas periodicamente e faz merge com
os contatos do RD Station.

**Chave de junção**: o "ID" da planilha (número no final da URL
`.../prospectos/editar/{id}`) é o mesmo valor do custom field `cf_id_crm` do
RD Station — confirmado manualmente contra dados reais (~95% das linhas da
planilha casam com um contato do RD).

**Nomes de coluna variam entre abas** (bagunça normal de planilha mantida à
mão) — o mapeamento em `lib/sheets-sync.js` usa aliases, não posição fixa.
Se o time de vendas criar uma aba nova com nomes de coluna muito diferentes
dos já mapeados, os campos dessa aba específica simplesmente não são
capturados (sem erro) até o alias ser adicionado ao código.

**Regra de "mais recente vence"**: se o mesmo lead aparece em mais de uma
aba/linha, fica valendo a interação com a data mais recente (fallback: mês
da aba, quando a data não estiver preenchida).

### Configuração

1. Reaproveite um OAuth Client ID (Desktop app) já existente no Google Cloud
   com a Sheets API ativada, ou crie um novo em
   [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
   Se for reaproveitar, gere uma **chave secreta nova** (`+ Add secret`) em
   vez de tentar recuperar a original (o Google não permite ver de novo).
2. Preencha `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` no `.env`.
3. Rode `npm run get-google-tokens`, autorize com a conta que tem acesso à
   planilha, e copie o `refresh_token` para `GOOGLE_REFRESH_TOKEN`.
4. Preencha `CRM_SHEET_ID` com o ID da planilha (parte da URL entre
   `/d/` e `/edit`).

## Atualização em tempo real (webhook de nova conversão)

Além do sync periódico (a cada `SYNC_INTERVAL_MINUTES`), o dashboard aceita
o webhook nativo de "Nova conversão" do RD Station Marketing, que atualiza o
contato na hora em vez de esperar o próximo ciclo:

1. No RD Station: **Sua Conta > Integrações > Webhooks > Criar Webhook**.
2. **URL**: `https://slac.autz.com.br/webhook/rd-conversion/SEU_WEBHOOK_SECRET`
   (troque `SEU_WEBHOOK_SECRET` pelo valor de `WEBHOOK_SECRET` no `.env`/Portainer).
3. **Gatilho**: Nova conversão (deixe em branco pra disparar em toda conversão).
4. Use o botão "Verificar" do RD Station pra confirmar que o endpoint responde.

O formato exato do payload que o RD Station envia não é documentado
publicamente, então o endpoint não confia no conteúdo — ele só extrai o
email do contato do payload e busca os dados completos e atualizados direto
na API (mesmo código do sync). Isso também significa que leads importados
ou inseridos manualmente no RD **não** disparam esse webhook (limitação do
próprio RD Station) — por isso o sync periódico continua rodando como rede
de segurança.

## Estrutura

- `server.js` — Express, Basic Auth, expõe `/api/leads` e `/api/sync-status`.
- `lib/rd-client.js` — cliente OAuth2 da API do RDSM (token, refresh, retry em 429).
- `lib/sync.js` — sincronização incremental: pagina a segmentação "Todos os
  contatos da base de Leads", e só busca detalhe + eventos de conversão de
  contatos novos ou com `last_conversion_date` alterado.
- `lib/db.js` — SQLite (módulo nativo `node:sqlite`), schema da tabela `contacts`.
- `lib/sheets-client.js` — cliente OAuth2 do Google Sheets (leitura).
- `lib/sheets-sync.js` — lê todas as abas da planilha de CRM, mapeia colunas
  por alias, e faz merge com os contatos via `cf_id_crm`.
- `public/` — frontend (tabela + filtros + modal de histórico), vanilla JS.
- `scripts/get-rd-tokens.js` — obtenção única do `refresh_token` do RD.
- `scripts/get-google-tokens.js` — obtenção única do `refresh_token` do Google.
- `scripts/import-csv.js` — bootstrap rápido a partir da exportação CSV do
  RD Station (ver seção abaixo).
- `scripts/run-sync.js` — roda um ciclo de sync do RD manualmente (`npm run sync`).
- `scripts/run-sheet-sync.js` — roda um ciclo de sync da planilha manualmente
  (`npm run sync-sheet`).

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha as credenciais do RD Station e do dashboard
```

### 1. Criar o aplicativo na RD Station App Store

Siga [Passo 1](https://developers.rdstation.com/reference/criar-aplicativo-appstore)
da documentação e cadastre a Callback URL `http://127.0.0.1:4568` (ou ajuste
`RD_REDIRECT_URI` no `.env` se preferir outra). Copie `client_id` e
`client_secret` para `RD_CLIENT_ID` / `RD_CLIENT_SECRET` no `.env`.

### 2. Obter o refresh_token

```bash
npm run get-rd-tokens
```

Abra a URL impressa no navegador, autorize com a conta RD Station do
cliente Slac, e copie o `refresh_token` impresso no terminal para
`RD_REFRESH_TOKEN` no `.env`.

### 3. Definir a senha do dashboard

Preencha `DASHBOARD_USER` / `DASHBOARD_PASSWORD` no `.env` — o dashboard
expõe dados pessoais de leads (nome, telefone, email) e fica protegido por
Basic Auth.

### 4. Bootstrap rápido via CSV (recomendado antes do primeiro sync)

A base tem dezenas de milhares de contatos — sincronizar tudo do zero via
API (3 chamadas por contato) demora muito. Em vez disso, exporte a base
pelo próprio RD Station (**Contatos > Exportar**) e importe o CSV direto:

```bash
npm run import-csv -- "caminho/para/export.csv"
```

Isso popula nome, telefone, tags, estágio no funil, custom fields, venda e
total de conversões na hora. Os contatos importados ficam marcados como
"ainda não enriquecidos" — o sync em segundo plano completa o histórico
detalhado de conversão (com atribuição de tráfego) depois, sem duplicar
trabalho.

### 5. Rodar

```bash
npm run dev
```

Acesse http://localhost:3000 (vai pedir usuário/senha). Na primeira
subida, o sync roda automaticamente em segundo plano — para forçar um ciclo
manual: `npm run sync`.

## Deploy na VPS — passo a passo (padrão RoyalServer)

Mesma receita do `Dash Contabilista Play`, adaptada para essa app:

### 1. Repositório

Crie o repositório `dash-slac-rdmarketing` no GitHub (privado) e faça push
deste código.

### 2. Deploy key na VPS (acesso de leitura ao repo)

Use um nome de arquivo específico pra essa chave (evita conflito se a VPS já
tiver outras deploy keys de outros projetos, ex. Dash Contabilista Play):

```bash
ssh-keygen -t ed25519 -C "dash-slac-rdmarketing-vps" -f ~/.ssh/dash_slac_rdmarketing_deploy -N ""
cat ~/.ssh/dash_slac_rdmarketing_deploy.pub
```

No GitHub: `Settings → Deploy keys → Add deploy key`, cole a chave pública
(sem marcar "Allow write access"). Teste:
`ssh -i ~/.ssh/dash_slac_rdmarketing_deploy -T git@github.com`.

### 3. Clonar o projeto na VPS

```bash
mkdir -p /root/projects
cd /root/projects
GIT_SSH_COMMAND="ssh -i ~/.ssh/dash_slac_rdmarketing_deploy" git clone git@github.com:<seu-usuario>/dash-slac-rdmarketing.git dash-slac-rdmarketing
cd dash-slac-rdmarketing
git config core.sshCommand "ssh -i ~/.ssh/dash_slac_rdmarketing_deploy"
chmod +x deploy.sh
```

### 4. Criar a stack no Portainer

Cole o conteúdo de `stack.yml`. Antes de fazer deploy da stack, adicione em
**Environment variables**:

```
RD_CLIENT_ID=...
RD_CLIENT_SECRET=...
RD_REFRESH_TOKEN=...
RD_SEGMENTATION_ID=15113383
SYNC_INTERVAL_MINUTES=30
DASHBOARD_USER=...
DASHBOARD_PASSWORD=...
WEBHOOK_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
CRM_SHEET_ID=...
SHEET_SYNC_INTERVAL_MINUTES=15
```

Como a imagem `dash-slac-rdmarketing:latest` ainda não existe na primeira
vez, rode manualmente na VPS antes de dar deploy da stack:

```bash
cd /root/projects/dash-slac-rdmarketing
docker build -t dash-slac-rdmarketing:latest .
```

Só então crie a stack no Portainer. O volume `dash-slac-rdmarketing-data`
persiste o SQLite entre deploys.

### 5. Descobrir o nome do service e ajustar o deploy.sh

```bash
docker service ls | grep dash-slac
```

Copie o nome (algo como `NOME_DA_STACK_dash-slac-rdmarketing`) e edite
`deploy.sh`, substituindo `STACK_NOME_SERVICO` por esse valor. Commit e
push essa alteração.

### 6. DNS

Na Cloudflare (ou seu DNS): registro `A`, nome `slac`, valor = IP público
da VPS.

### 7. Testar deploy manual

```bash
cd /root/projects/dash-slac-rdmarketing
./deploy.sh
```

### 8. Secrets do GitHub Actions (só para o SSH)

`Settings → Secrets and variables → Actions`:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP público da VPS |
| `VPS_USER` | usuário SSH (ex.: `root`) |
| `VPS_SSH_KEY` | chave **privada** SSH com acesso à VPS |

### 9. Fluxo do dia a dia

```bash
git add .
git commit -m "ajuste"
git push origin main
```

O GitHub Actions faz SSH na VPS e roda `deploy.sh` sozinho.

---


