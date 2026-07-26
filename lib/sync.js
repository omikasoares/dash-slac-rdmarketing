const rd = require('./rd-client');
const db = require('./db');

/**
 * Enriquece um contato sob demanda a partir do email (usado pelo webhook de
 * "nova conversao" do RD Station — nao confiamos no payload do webhook em si,
 * so usamos ele como sinal de "busque este contato agora" e vamos direto na
 * API, que e a fonte confiavel). Baixo volume, dispara so quando o RD Station
 * chama o webhook — a sincronizacao em massa da base roda no n8n
 * ("SLAC - Sync RD Station"), nao aqui.
 */

function itemsFrom(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
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

module.exports = { enrichContactByEmail };
