let leads = [];
let filtered = [];

const els = {
  tableBody: document.getElementById('tableBody'),
  searchInput: document.getElementById('searchInput'),
  stageFilter: document.getElementById('stageFilter'),
  tagFilter: document.getElementById('tagFilter'),
  syncDot: document.getElementById('syncDot'),
  syncLabel: document.getElementById('syncLabel'),
  syncNowBtn: document.getElementById('syncNowBtn'),
  overlay: document.getElementById('overlay'),
  modalClose: document.getElementById('modalClose'),
  modalName: document.getElementById('modalName'),
  modalEmail: document.getElementById('modalEmail'),
  modalContact: document.getElementById('modalContact'),
  modalCustomFields: document.getElementById('modalCustomFields'),
  modalEvents: document.getElementById('modalEvents'),
  modalSheet: document.getElementById('modalSheet'),
};

function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return 'nunca sincronizado';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return `há ${h}h`;
}

function stageClass(stage) {
  const s = (stage || '').toLowerCase();
  if (s.includes('cliente')) return 'stage-cliente';
  if (s.includes('oportunidade')) return 'stage-oportunidade';
  if (s.includes('lead')) return 'stage-lead';
  return 'stage-default';
}

function cell(value) {
  return value ? value : '<span class="empty-cell">—</span>';
}

function renderTable() {
  const search = els.searchInput.value.trim().toLowerCase();
  const stage = els.stageFilter.value;
  const tag = els.tagFilter.value;

  filtered = leads.filter((l) => {
    if (search) {
      const haystack = `${l.name || ''} ${l.email || ''} ${l.id_crm || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (stage && l.lifecycle_stage !== stage) return false;
    if (tag && !(l.tags || []).includes(tag)) return false;
    return true;
  });

  els.tableBody.innerHTML = filtered
    .map((l) => {
      const origin = [l.origin].filter(Boolean).join(' · ');
      const tagsHtml = (l.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
      const vendaHtml = l.last_sale_date
        ? `<span class="pill venda-sim">Sim</span> <span class="attrib">${formatDateTime(l.last_sale_date)}</span>`
        : '<span class="empty-cell">—</span>';
      return `
        <tr data-uuid="${l.uuid}">
          <td>${cell(escapeHtml(l.id_crm))}</td>
          <td>${escapeHtml(l.name || '—')}</td>
          <td>${escapeHtml(l.email || '—')}</td>
          <td>${cell(escapeHtml(l.mobile_phone || l.personal_phone || ''))}</td>
          <td>${cell(formatDateTime(l.created_at))}</td>
          <td>${cell(formatDateTime(l.last_conversion_date))}</td>
          <td>${cell(escapeHtml(origin))}</td>
          <td><span class="pill ${stageClass(l.lifecycle_stage)}">${escapeHtml(l.lifecycle_stage || 'Lead')}</span></td>
          <td>${vendaHtml}</td>
          <td>${cell(escapeHtml(l.falado))}</td>
          <td>${cell(escapeHtml(l.tabulacao_perda))}</td>
          <td>${cell(escapeHtml(l.consultor))}</td>
          <td>${tagsHtml || '<span class="empty-cell">—</span>'}</td>
        </tr>
      `;
    })
    .join('');

  els.tableBody.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => openModal(row.dataset.uuid));
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function populateFilters() {
  const stages = [...new Set(leads.map((l) => l.lifecycle_stage).filter(Boolean))].sort();
  const tags = [...new Set(leads.flatMap((l) => l.tags || []))].sort();

  els.stageFilter.innerHTML =
    '<option value="">Todos os estágios</option>' +
    stages.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  els.tagFilter.innerHTML =
    '<option value="">Todas as tags</option>' +
    tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

function openModal(uuid) {
  const l = leads.find((x) => x.uuid === uuid);
  if (!l) return;

  els.modalName.textContent = l.name || '—';
  els.modalEmail.textContent = l.email || '—';

  els.modalContact.innerHTML = [
    ['Telefone', l.mobile_phone || l.personal_phone],
    ['Criado em', formatDateTime(l.created_at)],
    ['Última conversão', formatDateTime(l.last_conversion_date)],
    ['Estágio', l.lifecycle_stage],
    ['Origem', l.origin],
    ['Total de conversões', l.total_conversions],
    ['Data da venda', formatDateTime(l.last_sale_date)],
    ['Data da oportunidade', formatDateTime(l.last_opportunity_date)],
    ['Dono do lead', l.owner_email],
  ]
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${escapeHtml(v || '—')}</div></div>`)
    .join('') + (l.public_url ? `<div><a href="${escapeHtml(l.public_url)}" target="_blank" rel="noopener">Abrir no RD Station →</a></div>` : '');

  const customFields = l.custom_fields || {};
  const cfEntries = Object.entries(customFields).filter(([, v]) => v !== null && v !== undefined && v !== '');
  els.modalCustomFields.innerHTML = cfEntries.length
    ? cfEntries
        .map(([k, v]) => `<div><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(Array.isArray(v) ? v.join(', ') : v)}</div></div>`)
        .join('')
    : '<span class="empty-cell">Nenhum custom field preenchido.</span>';

  const sheetFields = [
    ['Consultor', l.consultor],
    ['Falado', l.falado],
    ['Tabulação de perda', l.tabulacao_perda],
    ['Canal', l.canal_sheet],
    ['Tipo de tráfego', l.tipo_trafego_sheet],
    ['Público', l.publico_sheet],
    ['Criativo', l.criativo_sheet],
    ['Posição do anúncio', l.posicao_anuncio_sheet],
    ['Fluxo de mensagens', l.fluxo_mensagens],
    ['Última interação (planilha)', l.sheet_data_interacao],
    ['Aba de origem', l.sheet_tab_origem],
  ];
  const hasSheetData = sheetFields.some(([, v]) => v);
  els.modalSheet.innerHTML = hasSheetData
    ? sheetFields
        .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${escapeHtml(v || '—')}</div></div>`)
        .join('') +
      (l.observacao_comercial
        ? `<div style="grid-column:1/-1"><div class="k">Observação</div><div class="v">${escapeHtml(l.observacao_comercial)}</div></div>`
        : '')
    : '<span class="empty-cell">Sem correspondência na planilha de CRM.</span>';

  const events = l.events || [];
  if (events.length) {
    els.modalEvents.innerHTML = events
      .slice()
      .reverse()
      .map((e) => {
        const attrib = [e.traffic_source, e.traffic_campaign, e.traffic_value]
          .filter(Boolean)
          .join(' · ');
        return `
          <div class="event-item">
            <div>
              <div class="id">${escapeHtml(e.identifier || 'conversão')}</div>
              ${attrib ? `<div class="attrib">${escapeHtml(attrib)}</div>` : ''}
            </div>
            <div class="attrib">${formatDateTime(e.timestamp) || ''}</div>
          </div>
        `;
      })
      .join('');
  } else if (l.events_summary_raw) {
    const identifiers = l.events_summary_raw.split('/').map((s) => s.trim()).filter(Boolean);
    els.modalEvents.innerHTML =
      `<div class="notice">Ainda não sincronizado pela API — mostrando resumo da última exportação (sem timestamp por evento).</div>` +
      identifiers
        .map((id) => `<div class="event-item"><div class="id">${escapeHtml(id)}</div></div>`)
        .join('');
  } else {
    els.modalEvents.innerHTML = '<span class="empty-cell">Sem conversões registradas.</span>';
  }

  els.overlay.classList.add('open');
}

function closeModal() {
  els.overlay.classList.remove('open');
}

async function loadLeads() {
  const res = await fetch('/api/leads');
  leads = await res.json();
  populateFilters();
  renderTable();
}

async function loadSyncStatus() {
  const res = await fetch('/api/sync-status');
  const status = await res.json();
  const stale = status.last_sync_at && Date.now() - new Date(status.last_sync_at).getTime() > 2 * 60 * 60 * 1000;
  els.syncDot.classList.toggle('stale', !!stale || status.syncing);
  const rdLabel = status.syncing
    ? `sincronizando… (${status.total_contacts} leads)`
    : `${status.total_contacts} leads · atualizado ${timeAgo(status.last_sync_at)}`;
  const sheetLabel = status.syncingSheet
    ? 'planilha: sincronizando…'
    : `planilha: ${status.sheet_last_sync_matched} casados, atualizado ${timeAgo(status.sheet_last_sync_at)}`;
  els.syncLabel.textContent = `${rdLabel} · ${sheetLabel}`;
}

els.searchInput.addEventListener('input', renderTable);
els.stageFilter.addEventListener('change', renderTable);
els.tagFilter.addEventListener('change', renderTable);
els.modalClose.addEventListener('click', closeModal);
els.overlay.addEventListener('click', (e) => {
  if (e.target === els.overlay) closeModal();
});
els.syncNowBtn.addEventListener('click', async () => {
  els.syncNowBtn.disabled = true;
  await fetch('/api/sync-now', { method: 'POST' });
  await loadSyncStatus();
  els.syncNowBtn.disabled = false;
});

loadLeads();
loadSyncStatus();
setInterval(loadSyncStatus, 60_000);
setInterval(loadLeads, 5 * 60_000);
