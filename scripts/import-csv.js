/**
 * Importa a exportação de contatos do RD Station Marketing (Contatos > Exportar)
 * pra bootstrapar o SQLite rapidamente, sem depender do sync a frio via API.
 *
 * O export do RD vem em UTF-16LE, delimitado por TAB, com aspas no estilo CSV
 * pra campos que contêm quebra de linha (ex: Biografia).
 *
 * Uso:
 *   node scripts/import-csv.js caminho/para/export.csv
 *
 * Contatos importados ficam com synced_last_conversion_date = NULL, então o
 * sync em segundo plano (lib/sync.js) automaticamente busca o histórico
 * detalhado de conversão (com atribuição de tráfego) na próxima rodada —
 * exatamente como trataria um contato novo.
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../lib/db');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Uso: node scripts/import-csv.js caminho/para/export.csv');
  process.exit(1);
}

/** Detecta BOM UTF-16LE/BE; senão assume UTF-8. */
function readTextAutoEncoding(path) {
  const buf = fs.readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: node não decodifica nativamente, então trocamos os bytes.
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1);
  return buf.toString('utf8');
}

/** Parser TSV com suporte a células entre aspas contendo \t/\n (estilo CSV). */
function parseTsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }

    if (c === '"' && cell === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === '\t') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

// Colunas padrão -> nome do header no export do RD.
const COLS = {
  email: 'Email',
  name: 'Nome',
  personal_phone: 'Telefone',
  mobile_phone: 'Celular',
  lifecycle_stage: 'Estágio no funil',
  owner_email: 'Dono do Lead',
  last_opportunity_date: 'Data da última oportunidade',
  last_sale_date: 'Data da última venda',
  last_sale_value: 'Valor da última venda',
  tags: 'Tags',
  public_url: 'URL pública',
  total_conversions: 'Total de conversões',
  first_conversion_date: 'Data da primeira conversão',
  first_conversion_origin: 'Origem da primeira conversão',
  last_conversion_date: 'Data da última conversão',
  origin: 'Origem da última conversão',
  events_summary_raw: 'Eventos (Últimos 100)',
};

// Custom fields (cf_*) -> nome do header no export do RD. A ordem importa
// pras duas colunas "Qual seu ramo de atuação?" (nomes duplicados no export;
// resolvidas por posição, não por nome).
const CUSTOM_FIELD_COLS = {
  cf_escolaridade: 'Escolaridade',
  cf_forms: 'Formulário',
  cf_investimento_form_novo: 'Hoje você estaria disposto a investir na formação:',
  cf_id_crm: 'ID CRM',
  cf_groupid: 'ID no slacgroup',
  cf_invoice_id: 'Invoice ID',
  cf_curso_de_interesse: 'Qual seu curso de interesse?',
  cf_objetivo: 'Qual seu principal objetivo?',
  cf_formacao_profissional: 'Qual sua formação?',
  cf_idade: 'Qual sua idade?',
  cf_motivacao_educacional: 'Qual sua principal motivação para aprender Inglês?',
  cf_iniciar_formacao_form_novo: 'Quando você pretende iniciar a formação:',
  cf_ramo: 'Ramo',
  cf_rd_conversas_etapa: 'RD Conversas: Etapa',
  cf_utm_campaign: 'utm_campaign',
  cf_utm_content: 'utm_content',
  cf_utm_medium: 'utm_medium',
  cf_utm_source: 'utm_source',
  cf_utm_term: 'utm_term',
  cf_valor_pago: 'Valor Pago',
  cf_interesse_em_cursos: 'Você considera cursos na sua área importantes para se manter um bom profissional?',
  cf_falar_com_equipe: 'Você está disposto a conversar com nossa equipe  em uma chamada de vídeo/ou ligação?',
  cf_treinador_comportamental: 'Você já atua como treinador comportamental?',
  cf_empresario: 'Você é empresário?',
};

function extractUuid(publicUrl) {
  const match = /\/leads\/public\/([0-9a-f-]{36})/i.exec(publicUrl || '');
  return match ? match[1] : null;
}

function buildColumnIndex(headers) {
  const index = {};
  headers.forEach((h, i) => {
    if (!(h in index)) index[h] = [];
    index[h].push(i);
  });
  return index;
}

function run() {
  console.log('Lendo e decodificando arquivo...');
  const text = readTextAutoEncoding(filePath);
  console.log(`Arquivo lido: ${text.length} caracteres. Parseando TSV...`);
  const rows = parseTsv(text);
  console.log(`Parseado: ${rows.length} linhas (incluindo cabeçalho).`);
  if (rows.length < 2) {
    console.error('Arquivo vazio ou sem linhas de dados.');
    process.exit(1);
  }

  const headers = rows[0];
  const colIndex = buildColumnIndex(headers);
  const ramoAtuacaoCols = colIndex['Qual seu ramo de atuação?'] || [];

  let imported = 0;
  let skippedNoUuid = 0;

  for (let r = 1; r < rows.length; r++) {
    if (r % 5000 === 0) console.log(`Progresso: ${r}/${rows.length - 1} linhas...`);
    const cells = rows[r];
    const get = (header) => {
      const idxs = colIndex[header];
      if (!idxs || idxs.length === 0) return '';
      return (cells[idxs[0]] || '').trim();
    };

    const publicUrl = get(COLS.public_url);
    const uuid = extractUuid(publicUrl);
    if (!uuid) {
      skippedNoUuid += 1;
      continue;
    }

    const customFields = {};
    for (const [cfKey, header] of Object.entries(CUSTOM_FIELD_COLS)) {
      const value = get(header);
      if (value) customFields[cfKey] = value;
    }
    // As duas colunas "Qual seu ramo de atuação?" mapeiam para dois cf_ diferentes,
    // na ordem em que aparecem no export.
    if (ramoAtuacaoCols[0] !== undefined) {
      const v = (cells[ramoAtuacaoCols[0]] || '').trim();
      if (v) customFields.cf_ramo_atuacao_form_novo = v;
    }
    if (ramoAtuacaoCols[1] !== undefined) {
      const v = (cells[ramoAtuacaoCols[1]] || '').trim();
      if (v) customFields.cf_ramo_de_atuacao = v;
    }

    const tagsRaw = get(COLS.tags);
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    db.upsertContactFromCsv({
      uuid,
      name: get(COLS.name) || null,
      email: get(COLS.email) || null,
      personal_phone: get(COLS.personal_phone) || null,
      mobile_phone: get(COLS.mobile_phone) || null,
      tags: JSON.stringify(tags),
      lifecycle_stage: get(COLS.lifecycle_stage) || null,
      origin: get(COLS.origin) || null,
      last_conversion_date: get(COLS.last_conversion_date) || null,
      custom_fields: JSON.stringify(customFields),
      public_url: publicUrl || null,
      owner_email: get(COLS.owner_email) || null,
      total_conversions: get(COLS.total_conversions) ? Number(get(COLS.total_conversions)) : null,
      first_conversion_date: get(COLS.first_conversion_date) || null,
      first_conversion_origin: get(COLS.first_conversion_origin) || null,
      last_opportunity_date: get(COLS.last_opportunity_date) || null,
      last_sale_date: get(COLS.last_sale_date) || null,
      last_sale_value: get(COLS.last_sale_value) || null,
      events_summary_raw: get(COLS.events_summary_raw) || null,
      id_crm: customFields.cf_id_crm || null,
    });
    imported += 1;
  }

  console.log(`Importação concluída: ${imported} contatos gravados, ${skippedNoUuid} linhas sem UUID (URL pública) ignoradas.`);
}

run();
