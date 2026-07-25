# Dashboard de Leads — Slac (RD Station Marketing)

Dashboard que consolida os leads do RD Station Marketing (RDSM) da conta do
cliente Slac num painel único e pesquisável, sincronizando os dados em
segundo plano num banco Postgres (evita bater na API do RD a cada
carregamento de página).

## Escopo (v1)

Só dados do **RD Station Marketing**: nome, email, telefones, tags, custom
fields, data de criação, data da última conversão, histórico de conversão
(iscas/formulários) com atribuição de tráfego (canal/campanha/criativo) e
estágio no funil (Lead/Oportunidade/Cliente).

A exportação de contatos do próprio RD Station ("Contatos > Exportar") traz
de graça, além disso: estágio no funil, data/valor da última venda e
oportunidade, dono do lead, total de conversões, um resumo bruto dos
últimos 100 eventos, e o "Status para comunicação por email" (usado no
filtro de ativos — ver abaixo). `scripts/import-csv.js` faz bootstrap do
Postgres a partir desse export — útil porque a base é grande (dezenas de
milhares de contatos) e o primeiro sync via API, contato por contato,
demoraria muito.

**Vem da planilha de CRM/comercial** (Google Sheets, sincronizada a cada
`SHEET_SYNC_INTERVAL_MINUTES`, ver seção abaixo): consultor responsável,
falado/não falado, tabulação de perda, canal/tipo de tráfego/público/criativo
(quando presente na aba) e observações do atendimento comercial.

**Ainda fora do escopo** (não encontrado em nenhuma fonte disponível):
produto comprado como campo estruturado (é best-effort via evento/texto),
número de ligações/mensagens como contagem limpa (só como texto livre na
observação), e histórico de mensagens WhatsApp.

**Limitação conhecida da API do RD Station Marketing**: não existe endpoint
de histórico de e-mail (abertura/clique) por contato individual — só
analytics agregado por campanha/workflow. Isso é uma limitação da API, não
do dashboard. Da mesma forma, **"Status para comunicação por email" só é
exposto na exportação CSV, não na API de contato** — por isso o filtro de
ativos (ver abaixo) depende de reimportações periódicas do CSV, e trata
quem nunca passou por uma importação como "ativo" por padrão (status
desconhecido).

## Filtros do painel

- **Alunos por curso**: conta quem tem a tag `curso:*` correspondente
  (independe do estágio no funil). Clicar numa barra filtra a tabela por
  aquele curso.
- **Leads por período**: contagem por mês de criação do lead. Clicar numa
  barra equivale a clicar no pill do mês correspondente.
- **Mês / intervalo de datas**: os pills de mês e os campos "De"/"Até" são
  mutuamente exclusivos — escolher um limpa o outro.
- **Tag / sem a tag**: dá pra combinar "tem a tag X" com "não tem a tag Y"
  (ex.: aluno de PCC que ainda não é de PECC, pra upsell).
- **Só ativos / Todos**: esconde quem está com "Status para comunicação por
  email" = `false`, **exceto** se esse lead aparecer na aba da planilha de
  CRM do mês corrente (indício de que voltou a ser trabalhado pelo
  comercial). Contatos sem esse status conhecido (nunca passaram por uma
  reimportação de CSV) são tratados como ativos.

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

## Sincronização (RD Station)

O sync roda em segundo plano, sem intervalo fixo o dia inteiro — mais
frequente em horário comercial, mais espaçado fora dele:

- Das `SYNC_BUSINESS_START` às `SYNC_BUSINESS_END` (padrão **07:50–19:00**,
  fuso `America/Sao_Paulo`, calculado via `Intl` — não depende de tzdata
  no container): a cada `SYNC_INTERVAL_BUSINESS_MINUTES` (padrão **5 min**).
- Fora desse horário: a cada `SYNC_INTERVAL_OFFHOURS_MINUTES` (padrão
  **60 min**).

Dentro de cada ciclo, a fase de detalhe (contato + eventos + funil, cara —
2 a 3 chamadas extras por lead novo/alterado) roda com paralelismo limitado
(`SYNC_CONCURRENCY`, padrão **15** contatos simultâneos), e todas as
chamadas à API do RD passam por um limitador de taxa proativo
(`RD_MAX_REQUESTS_PER_MINUTE`, padrão **100/min**) — evita cair em 429 e
pagar o backoff (2s/4s/6s/8s por tentativa), que é o que tornava o sync
lento antes dessa mudança. Se os logs do container mostrarem `429` com
frequência mesmo assim, abaixe `RD_MAX_REQUESTS_PER_MINUTE` sem precisar
mexer no código.

O sync da planilha de CRM continua num intervalo fixo simples
(`SHEET_SYNC_INTERVAL_MINUTES`, padrão 15 min) — não depende de horário
comercial.

## Atualização em tempo real (webhook de nova conversão)

Além do sync periódico acima, o dashboard aceita o webhook nativo de "Nova
conversão" do RD Station Marketing, que atualiza o contato na hora em vez
de esperar o próximo ciclo:

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

- `server.js` — Express, Basic Auth, expõe `/api/leads` e `/api/sync-status`,
  agenda o sync em horário comercial (ver seção acima).
- `lib/rd-client.js` — cliente OAuth2 da API do RDSM (token, refresh,
  limitador de taxa proativo, retry em 429).
- `lib/sync.js` — sincronização incremental: pagina a segmentação "Todos os
  contatos da base de Leads", e só busca detalhe + eventos (em paralelo,
  `SYNC_CONCURRENCY`) de contatos novos ou com `last_conversion_date`
  alterado.
- `lib/db.js` — Postgres (driver `pg`), schema da tabela `contacts`.
  tags/custom_fields/events/produtos_comprados são colunas JSONB.
- `lib/sheets-client.js` — cliente OAuth2 do Google Sheets (leitura).
- `lib/sheets-sync.js` — lê todas as abas da planilha de CRM, mapeia colunas
  por alias, e faz merge com os contatos via `cf_id_crm`.
- `public/` — frontend (KPIs + gráficos de curso/período + tabela + filtros
  + modal de histórico), vanilla JS.
- `scripts/get-rd-tokens.js` — obtenção única do `refresh_token` do RD.
- `scripts/get-google-tokens.js` — obtenção única do `refresh_token` do Google.
- `scripts/import-csv.js` — bootstrap rápido a partir da exportação CSV do
  RD Station (ver seção abaixo), incluindo o status de comunicação por
  email usado no filtro de ativos.
- `scripts/run-sync.js` — roda um ciclo de sync do RD manualmente (`npm run sync`).
- `scripts/run-sheet-sync.js` — roda um ciclo de sync da planilha manualmente
  (`npm run sync-sheet`).

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha as credenciais do RD Station e do dashboard
```

Precisa de um Postgres local ou remoto — o mais simples pra dev é subir um
container solto:

```bash
docker run -d --name dash-slac-postgres-dev -p 5432:5432 \
  -e POSTGRES_USER=dash -e POSTGRES_PASSWORD=dash -e POSTGRES_DB=dash_slac \
  postgres:16-alpine
```

E preencher `DATABASE_URL=postgres://dash:dash@localhost:5432/dash_slac` no
`.env`. O schema é criado automaticamente na primeira subida do app (não
precisa rodar migração manual).

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
API (2-3 chamadas por contato) demora muito, mesmo com o sync paralelo. Em
vez disso, exporte a base pelo próprio RD Station (**Contatos > Exportar**)
e importe o CSV direto:

```bash
npm run import-csv -- "caminho/para/export.csv"
```

Isso popula nome, telefone, tags, estágio no funil, custom fields, venda,
total de conversões **e o status de comunicação por email** (usado no
filtro de ativos) na hora, dentro de uma única transação. Os contatos
importados ficam marcados como "ainda não enriquecidos" — o sync em
segundo plano completa o histórico detalhado de conversão (com atribuição
de tráfego) depois, sem duplicar trabalho.

Como esse status de email só vem do CSV, **reimporte esse export
periodicamente** (ex.: uma vez por semana/mês) pra manter o filtro de
ativos atualizado — leads sincronizados só pela API entre uma importação e
outra ficam com status "desconhecido" (tratados como ativos).

### 5. Rodar

```bash
npm run dev
```

Acesse http://localhost:3000 (vai pedir usuário/senha). Na primeira
subida, o sync roda automaticamente em segundo plano — para forçar um ciclo
manual: `npm run sync`.

## Deploy na VPS — passo a passo (padrão RoyalServer)

Mesma receita do `Dash Contabilista Play`, adaptada para essa app:

> **Migrando um deploy que já existia em SQLite?** Repositório, deploy key,
> DNS e secrets do GitHub Actions (passos 1, 2, 3, 6 e 9) já estão feitos —
> pule direto pros passos **4** (redeploy da stack, agora com o serviço do
> Postgres) e **7** (popular o banco novo via CSV). O volume antigo
> `dash-slac-rdmarketing-data` (SQLite) fica órfão depois disso — só remova
> pelo Portainer depois de confirmar que o dashboard novo está funcionando
> com os dados certos.

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

Cole o conteúdo de `stack.yml` — agora tem **dois** serviços:
`dash-slac-postgres` (banco, novo) e `dash-slac-rdmarketing` (app). Antes
de fazer deploy da stack, adicione em **Environment variables**:

```
RD_CLIENT_ID=...
RD_CLIENT_SECRET=...
RD_REFRESH_TOKEN=...
RD_SEGMENTATION_ID=15113383
RD_MAX_REQUESTS_PER_MINUTE=100
SYNC_CONCURRENCY=15
SYNC_BUSINESS_START=07:50
SYNC_BUSINESS_END=19:00
SYNC_INTERVAL_BUSINESS_MINUTES=5
SYNC_INTERVAL_OFFHOURS_MINUTES=60
DASHBOARD_USER=...
DASHBOARD_PASSWORD=...
WEBHOOK_SECRET=...
POSTGRES_USER=dash_slac
POSTGRES_PASSWORD=... (gere uma senha forte)
POSTGRES_DB=dash_slac
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
CRM_SHEET_ID=...
SHEET_SYNC_INTERVAL_MINUTES=15
```

`DATABASE_URL` **não precisa ser preenchida à mão** — o `stack.yml` já monta
ela sozinha a partir de `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` e
do nome interno do serviço do banco.

Como a imagem `dash-slac-rdmarketing:latest` ainda não existe na primeira
vez, rode manualmente na VPS antes de dar deploy da stack:

```bash
cd /root/projects/dash-slac-rdmarketing
docker build -t dash-slac-rdmarketing:latest .
```

Só então crie a stack no Portainer. O volume `dash-slac-postgres-data`
persiste o Postgres entre deploys (o app em si não guarda mais nada em
disco — pode escalar/recriar o container do app à vontade).

### 5. Descobrir o nome do service e ajustar o deploy.sh

```bash
docker service ls | grep dash-slac
```

Copie o nome do serviço **do app** (algo como
`NOME_DA_STACK_dash-slac-rdmarketing` — não o do Postgres) e edite
`deploy.sh`, substituindo `STACK_NOME_SERVICO` por esse valor. Commit e
push essa alteração.

### 6. DNS

Na Cloudflare (ou seu DNS): registro `A`, nome `slac`, valor = IP público
da VPS.

### 7. Popular o banco novo

O Postgres começa vazio. Antes de considerar o deploy pronto, rode o
bootstrap via CSV **contra o Postgres da VPS** (exporte `DATABASE_URL`
apontando pra ele, ou rode o script de dentro do container via
`docker exec`) — ver seção "Bootstrap rápido via CSV" acima. Sem isso, o
dashboard fica de pé mas vazio até o primeiro sync completo via API
terminar (pode levar bem mais tempo que o bootstrap).

### 8. Testar deploy manual

```bash
cd /root/projects/dash-slac-rdmarketing
./deploy.sh
```

### 9. Secrets do GitHub Actions (só para o SSH)

`Settings → Secrets and variables → Actions`:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP público da VPS |
| `VPS_USER` | usuário SSH (ex.: `root`) |
| `VPS_SSH_KEY` | chave **privada** SSH com acesso à VPS |

### 10. Fluxo do dia a dia

```bash
git add .
git commit -m "ajuste"
git push origin main
```

O GitHub Actions faz SSH na VPS e roda `deploy.sh` sozinho.

---
