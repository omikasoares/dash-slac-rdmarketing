const rd = require('./rd-client');
const db = require('./db');

const SEGMENTATION_ID = process.env.RD_SEGMENTATION_ID || '15113383';

/** Quantos contatos processar em paralelo na fase de detalhe (getContact +
 * eventos + funil). As requisicoes em si ja sao espacadas pelo rate limiter
 * do rd-client, entao isso so controla quantos contatos ficam "em voo" ao
 * mesmo tempo pra nao deixar o pipeline ocioso esperando um contato lento. */
const SYNC_CONCURRENCY = Number(process.env.SYNC_CONCURRENCY) || 15;

function itemsFrom(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

/** Roda `fn` sobre `items` com no maximo `concurrency` execucoes simultaneas. */
async function mapWithConcurrency(items, concurrency, fn) {
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
}

async function fetchAllSegmentationContacts() {
  const all = [];
  for (let page = 1; page <= 2000; page++) {
    const data = await rd.listSegmentationContacts(SEGMENTATION_ID, page);
    const items = itemsFrom(data, 'contacts');
    if (items.length === 0) break;
    all.push(...items);
  }
  return all;
}

async function fetchAllContactEvents(uuid) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const data = await rd.getContactEvents(uuid, 'CONVERSION', page);
    const items = itemsFrom(data, 'events', 'conversions');
    if (items.length === 0) break;
    all.push(...items);
  }
  return all;
}

function extractCustomFields(contact) {
  const customFields = {};
  for (const [key, value] of Object.entries(contact)) {
    if (key.startsWith('cf_')) customFields[key] = value;
  }
  return customFields;
}

/**
 * Extrai produtos comprados a partir dos eventos de conversao. O RD Station
 * registra vendas como um evento cujo identificador segue o padrao
 * "Compra aprovada - {produto}" (ex: "Compra aprovada - PCC - Professional
 * Coach Certification"). Nao existe campo estruturado pra isso na API — e
 * best-effort sobre o texto do identifier, pode haver mais de uma compra.
 */
function extractProdutosComprados(events) {
  const produtos = [];
  for (const e of events) {
    const identifier = String(e.event_identifier || '').trim();
    const match = /^compra aprovada\s*[-:]\s*(.+)$/i.exec(identifier);
    if (match) produtos.push(match[1].trim());
  }
  return [...new Set(produtos)];
}

/** Busca detalhe + eventos + funil de um contato e grava no Postgres. */
async function syncContactDetail(row) {
  const [contact, events, funnel] = await Promise.all([
    rd.getContact(row.uuid),
    fetchAllContactEvents(row.uuid),
    rd.getContactFunnelStage(row.uuid).catch(() => null),
  ]);

  await db.upsertContactDetail({
    uuid: row.uuid,
    personal_phone: contact.personal_phone || null,
    mobile_phone: contact.mobile_phone || null,
    tags: JSON.stringify(contact.tags || []),
    lifecycle_stage: funnel?.lifecycle_stage || null,
    origin: funnel?.origin || null,
    custom_fields: JSON.stringify(extractCustomFields(contact)),
    events: JSON.stringify(
      events.map((e) => ({
        identifier: e.event_identifier,
        timestamp: e.event_timestamp,
        traffic_source: e.payload?.traffic_source || null,
        traffic_medium: e.payload?.traffic_medium || null,
        traffic_campaign: e.payload?.traffic_campaign || null,
        traffic_value: e.payload?.traffic_value || null,
      }))
    ),
    produtos_comprados: JSON.stringify(extractProdutosComprados(events)),
    synced_last_conversion_date: row.last_conversion_date || null,
    last_synced_at: new Date().toISOString(),
    id_crm: extractCustomFields(contact).cf_id_crm || null,
  });
}

/**
 * Enriquece um contato sob demanda a partir do email (usado pelo webhook de
 * "nova conversao" do RD Station — nao confiamos no payload do webhook em si,
 * so usamos ele como sinal de "busque este contato agora" e vamos direto na
 * API, que e a fonte confiavel).
 */
async function enrichContactByEmail(email) {
  const contact = await rd.getContactByIdentifier('email', email);
  const uuid = contact.uuid;

  const [events, funnel] = await Promise.all([
    fetchAllContactEvents(uuid),
    rd.getContactFunnelStage(uuid).catch(() => null),
  ]);

  const lastConversionDate = events.reduce(
    (max, e) => (!max || e.event_timestamp > max ? e.event_timestamp : max),
    null
  );

  await db.upsertContactIndex({
    uuid,
    name: contact.name || null,
    email: contact.email || email,
    created_at: null,
    last_conversion_date: lastConversionDate,
  });

  await db.upsertContactDetail({
    uuid,
    personal_phone: contact.personal_phone || null,
    mobile_phone: contact.mobile_phone || null,
    tags: JSON.stringify(contact.tags || []),
    lifecycle_stage: funnel?.lifecycle_stage || null,
    origin: funnel?.origin || null,
    custom_fields: JSON.stringify(extractCustomFields(contact)),
    events: JSON.stringify(
      events.map((e) => ({
        identifier: e.event_identifier,
        timestamp: e.event_timestamp,
        traffic_source: e.payload?.traffic_source || null,
        traffic_medium: e.payload?.traffic_medium || null,
        traffic_campaign: e.payload?.traffic_campaign || null,
        traffic_value: e.payload?.traffic_value || null,
      }))
    ),
    produtos_comprados: JSON.stringify(extractProdutosComprados(events)),
    synced_last_conversion_date: lastConversionDate,
    last_synced_at: new Date().toISOString(),
    id_crm: extractCustomFields(contact).cf_id_crm || null,
  });

  return uuid;
}

/**
 * Sync incremental: pagina a segmentacao (barato), e so busca detalhe +
 * eventos (caro, 2-3 chamadas extras por contato) para quem e novo ou teve
 * last_conversion_date alterado desde o ultimo sync. A fase de detalhe roda
 * com paralelismo limitado (SYNC_CONCURRENCY) — as requisicoes em si sao
 * espacadas pelo rate limiter do rd-client, entao isso so evita ficar
 * ocioso esperando contato por contato.
 */
async function runSync() {
  const startedAt = Date.now();
  const contacts = await fetchAllSegmentationContacts();

  const needsDetailRows = [];
  let skipped = 0;

  for (const row of contacts) {
    await db.upsertContactIndex({
      uuid: row.uuid,
      name: row.name || null,
      email: row.email || null,
      created_at: row.created_at || null,
      last_conversion_date: row.last_conversion_date || null,
    });

    const existing = await db.getContactByUuid(row.uuid);
    const needsDetail =
      !existing.synced_last_conversion_date || existing.synced_last_conversion_date !== row.last_conversion_date;

    if (needsDetail) {
      needsDetailRows.push(row);
    } else {
      skipped += 1;
    }
  }

  let updated = 0;
  await mapWithConcurrency(needsDetailRows, SYNC_CONCURRENCY, async (row) => {
    try {
      await syncContactDetail(row);
      updated += 1;
    } catch (e) {
      console.warn(`Erro ao sincronizar detalhe do contato ${row.uuid} (${row.email}):`, e.message);
    }
  });

  await db.setMeta('last_sync_at', new Date().toISOString());
  await db.setMeta('last_sync_duration_ms', Date.now() - startedAt);
  await db.setMeta('total_contacts', await db.countContacts());

  console.log(
    `Sync concluído: ${contacts.length} contatos na segmentação, ${updated} detalhados, ${skipped} sem mudança. (${Date.now() - startedAt}ms)`
  );
}

module.exports = { runSync, enrichContactByEmail };
