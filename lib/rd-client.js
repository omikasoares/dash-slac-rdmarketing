/**
 * Cliente HTTP para a API do RD Station Marketing (RDSM).
 * Docs: https://developers.rdstation.com/reference/introducao-rdsm
 *
 * - access_token dura 24h, refresh_token não expira.
 * - Refresh automático em 401, retry com backoff em 429 (rate limit).
 */
const BASE_URL = 'https://api.rd.services';

const CLIENT_ID = process.env.RD_CLIENT_ID;
const CLIENT_SECRET = process.env.RD_CLIENT_SECRET;
let refreshToken = process.env.RD_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !refreshToken) {
  throw new Error('Defina RD_CLIENT_ID, RD_CLIENT_SECRET e RD_REFRESH_TOKEN (.env) antes de usar o rd-client.');
}

let accessToken = null;
let accessTokenExpiresAt = 0;

async function refreshAccessToken() {
  const res = await fetch(`${BASE_URL}/auth/token?token_by=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Falha ao renovar access_token (${res.status}): ${text}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 86400) * 1000 - 60_000;

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    console.warn(
      'RD Station retornou um novo refresh_token. Atualize RD_REFRESH_TOKEN no .env/Portainer com:\n',
      refreshToken
    );
  }
}

async function getAccessToken() {
  if (!accessToken || Date.now() >= accessTokenExpiresAt) {
    await refreshAccessToken();
  }
  return accessToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { params, retryOn401 = true, attempt = 1 } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 && retryOn401) {
    accessToken = null;
    return request(path, { params, retryOn401: false, attempt });
  }

  if (res.status === 429 && attempt <= 4) {
    const waitMs = attempt * 2000;
    console.warn(`Rate limit do RD Station (429) em ${path}, aguardando ${waitMs}ms (tentativa ${attempt})`);
    await sleep(waitMs);
    return request(path, { params, retryOn401, attempt: attempt + 1 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RD Station API ${res.status} em ${path}: ${text}`);
  }

  return res.json();
}

/** Lista contatos de uma segmentação (paginado). */
function listSegmentationContacts(segmentationId, page = 1) {
  return request(`/platform/segmentations/${segmentationId}/contacts`, { params: { page } });
}

/** Detalhe completo de um contato (campos padrão + custom fields). */
function getContact(uuid) {
  return getContactByIdentifier('uuid', uuid);
}

/** Detalhe completo de um contato, buscando por uuid ou email. */
function getContactByIdentifier(identifierType, value) {
  return request(`/platform/contacts/${identifierType}:${encodeURIComponent(value)}`);
}

/** Eventos do contato. event_type: CONVERSION | OPPORTUNITY */
function getContactEvents(uuid, eventType = 'CONVERSION', page = 1) {
  return request(`/platform/contacts/${uuid}/events`, { params: { event_type: eventType, page, order: 'created_at', direction: 'asc' } });
}

/** Estágio no funil padrão do contato (lifecycle_stage: Lead/Cliente/etc). */
function getContactFunnelStage(uuid) {
  return request(`/platform/contacts/${uuid}/funnels/default`);
}

module.exports = {
  listSegmentationContacts,
  getContact,
  getContactByIdentifier,
  getContactEvents,
  getContactFunnelStage,
};
