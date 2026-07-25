/**
 * Sync com a planilha de CRM/comercial (Google Sheets) mantida pelo time de
 * vendas do cliente Slac. Uma aba por mes, colunas com nomes ligeiramente
 * diferentes entre abas (baguncao normal de planilha mantida manualmente) —
 * por isso o mapeamento e por alias, nao por posicao fixa.
 *
 * Join com os contatos do RD Station: o "ID" da planilha (numero no final da
 * URL .../prospectos/editar/{id}) e o mesmo valor do custom field cf_id_crm
 * do RD Station (confirmado manualmente contra dados reais).
 */
const sheetsClient = require('./sheets-client');
const db = require('./db');

const SPREADSHEET_ID = process.env.CRM_SHEET_ID;

const ALIASES = {
  ID: ['id', 'url do lead crm (id)', 'url do lead crm'],
  CONSULTOR: ['consultor (a)', 'consultora', 'consultor'],
  DATA: ['data', 'data — conversao', 'data - conversao', 'data conversao'],
  FLUXO_MENSAGENS: ['fluxo de mensagens'],
  UTM_CRIATIVO: ['utm criativo'],
  CAMPANHA_CONVERTEU: ['campanha que converteu'],
  VALID_LEAD: ['valid lead'],
  STATUS_LEAD: ['status lead'],
  OBSERVACAO: ['observação', 'observacao'],
  AUDIO: ['audio'],
};

const MONTH_NAMES = {
  janeiro: 1, fevereiro: 2,'março': 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function normalizeHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildColumnIndex(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const index = {};
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const i = normalized.indexOf(alias);
      if (i !== -1) {
        index[key] = i;
        break;
      }
    }
  }
  return index;
}

/** Extrai o ID CRM de uma celula (URL .../editar/{id}, ou o numero puro). */
function extractIdCrm(cellValue) {
  const str = String(cellValue == null ? '' : cellValue);
  const match = /editar\/(\d+)/.exec(str);
  if (match) return match[1];
  const trimmed = str.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Estima o numero de tentativas de contato a partir do texto livre da
 * Observacao. O time comercial concatena os atendimentos em ordem
 * decrescente (mais recente primeiro), ex:
 *   "Contato 03 - Fiz 5 Ligações - ... - Contato 02 - ... - Contato 01 - ..."
 * O primeiro numero apos "Contato" e o total de tentativas ate o momento.
 * Best-effort: o texto e livre e nem sempre segue o padrao a risca.
 */
function extractNumeroContatos(observacao) {
  if (!observacao) return null;
  const match = /contato\s+(\d+)/i.exec(observacao);
  return match ? Number(match[1]) : null;
}

/** Parseia data no formato DD/MM/AAAA (com ou sem hora junto). */
function parseBrDate(str) {
  if (!str) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(str).trim());
  if (!match) return null;
  const [, d, m, y] = match;
  const time = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Chave de ordenacao a partir do nome da aba (ex: "JUNHO 2026" -> 202606). */
function tabSortKey(tabName) {
  const normalized = normalizeHeader(tabName);
  const yearMatch = /(\d{4})/.exec(normalized);
  const year = yearMatch ? Number(yearMatch[1]) : 0;
  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    if (normalized.includes(name)) return year * 100 + num;
  }
  return 0;
}

async function runSheetSync() {
  if (!SPREADSHEET_ID) {
    console.warn('CRM_SHEET_ID não definido — pulando sync da planilha.');
    return;
  }

  const startedAt = Date.now();
  const idCrmMap = await db.getIdCrmMap();
  const tabs = await sheetsClient.listSheetTabs(SPREADSHEET_ID);

  const latestByIdCrm = new Map();
  let invalidId = 0;

  for (const tab of tabs) {
    let values;
    try {
      values = await sheetsClient.getSheetValues(SPREADSHEET_ID, tab);
    } catch (e) {
      console.warn(`Erro ao ler a aba "${tab}":`, e.message);
      continue;
    }
    if (values.length < 2) continue;

    const colIndex = buildColumnIndex(values[0]);
    if (colIndex.ID === undefined) continue;

    const tabKey = tabSortKey(tab);

    for (let r = 1; r < values.length; r++) {
      const cells = values[r];
      const rawIdCell = cells[colIndex.ID];
      const idCrm = extractIdCrm(rawIdCell);
      if (!idCrm) {
        // Linha com conteudo na coluna ID mas em formato inesperado (nao e
        // uma URL .../editar/{id} nem um numero puro) — provavel erro de
        // digitacao do time comercial (ex: colou anotação em vez do link).
        // Celula vazia nao conta como erro, so como linha em branco.
        if (rawIdCell && String(rawIdCell).trim()) invalidId += 1;
        continue;
      }

      const dataStr = colIndex.DATA !== undefined ? cells[colIndex.DATA] : null;
      const parsedDate = parseBrDate(dataStr);

      const existing = latestByIdCrm.get(idCrm);
      if (existing) {
        const existingRank = existing.parsedDate ?? existing.tabKey;
        const currentRank = parsedDate ?? tabKey;
        if (currentRank < existingRank) continue;
      }

      latestByIdCrm.set(idCrm, { cells, colIndex, tab, tabKey, parsedDate });
    }
  }

  let matched = 0;
  let notFound = 0;

  for (const [idCrm, entry] of latestByIdCrm) {
    const uuid = idCrmMap.get(idCrm);
    if (!uuid) {
      notFound += 1;
      continue;
    }

    const get = (key) => {
      const i = entry.colIndex[key];
      return i !== undefined ? String(entry.cells[i] || '').trim() : '';
    };

    const utmRaw = get('UTM_CRIATIVO');
    const utmParts = utmRaw ? utmRaw.split('\t').map((s) => s.trim()) : [];
    const observacao = get('OBSERVACAO') || get('AUDIO') || null;

    await db.upsertSheetData({
      uuid,
      consultor: get('CONSULTOR') || null,
      canal_sheet: utmParts[0] || null,
      tipo_trafego_sheet: utmParts[1] || null,
      publico_sheet: utmParts[2] || null,
      criativo_sheet: utmParts[3] || null,
      posicao_anuncio_sheet: utmParts[4] || null,
      campanha_converteu_sheet: get('CAMPANHA_CONVERTEU') || null,
      falado: get('VALID_LEAD') || null,
      tabulacao_perda: get('STATUS_LEAD') || null,
      observacao_comercial: observacao,
      fluxo_mensagens: get('FLUXO_MENSAGENS') || null,
      numero_contatos_estimado: extractNumeroContatos(observacao),
      sheet_tab_origem: entry.tab,
      sheet_data_interacao: get('DATA') || null,
      sheet_last_synced_at: new Date().toISOString(),
    });
    matched += 1;
  }

  await db.setMeta('sheet_last_sync_at', new Date().toISOString());
  await db.setMeta('sheet_last_sync_matched', matched);
  await db.setMeta('sheet_last_sync_not_found', notFound);
  await db.setMeta('sheet_last_sync_invalid_id', invalidId);
  await db.setMeta('sheet_last_sync_duration_ms', Date.now() - startedAt);

  console.log(
    `Sync da planilha concluído: ${latestByIdCrm.size} leads na planilha, ${matched} casados com contatos do RD, ${notFound} sem correspondência, ${invalidId} com ID em formato inválido. (${Date.now() - startedAt}ms)`
  );
}

module.exports = { runSheetSync };
