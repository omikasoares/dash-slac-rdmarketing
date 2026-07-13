const rd = require('./rd-client');
const db = require('./db');

const SEGMENTATION_ID = process.env.RD_SEGMENTATION_ID || '15113383';

function itemsFrom(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
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

/** Busca detalhe + eventos + funil de um contato e grava no SQLite. */
async function syncContactDetail(row) {
  const [contact, events, funnel] = await Promise.all([
    rd.getContact(row.uuid),
    fetchAllContactEvents(row.uuid),
    rd.getContactFunnelStage(row.uuid).catch(() => null),
  ]);

  db.upsertContactDetail({
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
    synced_last_conversion_date: row.last_conversion_date || null,
    last_synced_at: new Date().toISOString(),
  });
}

/**
 * Enriquece um contato sob demanda a partir do email (usado pelo webhook de
 * "nova conversão" do RD Station — não confiamos no payload do webhook em si,
 * só usamos ele como sinal de "busque este contato agora" e vamos direto na
 * API, que é a fonte confiável).
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

  db.upsertContactIndex({
    uuid,
    name: contact.name || null,
    email: contact.email || email,
    created_at: null,
    last_conversion_date: lastConversionDate,
  });

  db.upsertContactDetail({
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
    synced_last_conversion_date: lastConversionDate,
    last_synced_at: new Date().toISOString(),
  });

  return uuid;
}

/**
 * Sync incremental: pagina a segmentação (barato), e só busca detalhe +
 * eventos (caro, 2-3 chamadas extras por contato) para quem é novo ou teve
 * last_conversion_date alterado desde o último sync.
 */
async function runSync() {
  const startedAt = Date.now();
  const contacts = await fetchAllSegmentationContacts();

  let updated = 0;
  let skipped = 0;

  for (const row of contacts) {
    db.upsertContactIndex({
      uuid: row.uuid,
      name: row.name || null,
      email: row.email || null,
      created_at: row.created_at || null,
      last_conversion_date: row.last_conversion_date || null,
    });

    const existing = db.getContactByUuid(row.uuid);
    const needsDetail =
      !existing.synced_last_conversion_date || existing.synced_last_conversion_date !== row.last_conversion_date;

    if (needsDetail) {
      try {
        await syncContactDetail(row);
        updated += 1;
      } catch (e) {
        console.warn(`Erro ao sincronizar detalhe do contato ${row.uuid} (${row.email}):`, e.message);
      }
    } else {
      skipped += 1;
    }
  }

  db.setMeta('last_sync_at', new Date().toISOString());
  db.setMeta('last_sync_duration_ms', Date.now() - startedAt);
  db.setMeta('total_contacts', db.countContacts());

  console.log(
    `Sync concluído: ${contacts.length} contatos na segmentação, ${updated} detalhados, ${skipped} sem mudança. (${Date.now() - startedAt}ms)`
  );
}

module.exports = { runSync, enrichContactByEmail };
