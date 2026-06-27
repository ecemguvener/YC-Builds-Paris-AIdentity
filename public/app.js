// Minimal vanilla-JS dashboard. Talks to the Payment Tool API on the same origin.
const $ = (sel) => document.querySelector(sel);
let currentAgent = null;
let currentActivity = null;

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || res.statusText), { json });
  return json;
}

function badge(status) {
  return `<span class="badge ${status}">${status.replace(/_/g, ' ')}</span>`;
}
function fmt(amount, currency) {
  return `${currency === 'GBP' ? '£' : ''}${Number(amount).toFixed(2)}${currency !== 'GBP' ? ' ' + currency : ''}`;
}

// ── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
  }),
);

// ── Load agents into the picker ───────────────────────────────────────────────
async function loadAgents() {
  const { agents } = await api('GET', '/agents');
  const sel = $('#agentSelect');
  sel.innerHTML = agents
    .map((a) => `<option value="${a.agent_id}">${a.name} (${a.agent_id})</option>`)
    .join('');
  currentAgent = agents[0]?.agent_id;
  sel.addEventListener('change', () => {
    currentAgent = sel.value;
    refresh();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderIdentity(agent) {
  $('#identityInfo').innerHTML = !agent
    ? '<div class="empty">No agent</div>'
    : [
        ['Agent ID', agent.agent_id],
        ['Name', agent.name],
        ['Owner', agent.owner_user_id],
        ['Email', agent.email || '—'],
        ['Phone', agent.phone || '—'],
        ['Calendar', agent.calendar || '—'],
      ]
        .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
        .join('');
}

function renderPaymentIdentity(pi) {
  const el = $('#paymentIdentity');
  if (!pi) {
    el.innerHTML = '<div class="empty">No payment identity yet — click Attach.</div>';
    $('#attachBtn').style.display = '';
    return;
  }
  $('#attachBtn').style.display = 'none';
  el.innerHTML = `<div class="kv">
    <div class="k">Provider</div><div class="v">${pi.provider}</div>
    <div class="k">Card</div><div class="v">•••• ${pi.card_last4}</div>
    <div class="k">Status</div><div class="v">${badge(pi.status)}</div>
  </div>`;
}

function renderPolicy(p) {
  $('#policyView').innerHTML = !p
    ? '<div class="empty">No policy set → all requests require approval.</div>'
    : [
        ['Max / transaction', fmt(p.max_transaction_amount, 'GBP')],
        ['Daily limit', fmt(p.daily_limit, 'GBP')],
        ['Monthly limit', fmt(p.monthly_limit, 'GBP')],
        ['Approval above', fmt(p.approval_required_above, 'GBP')],
        ['Allowed', p.allowed_merchants.join(', ') || '—'],
        ['Blocked', p.blocked_merchants.join(', ') || '—'],
        ['Recurring', p.allow_recurring ? 'allowed' : 'blocked'],
      ]
        .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
        .join('');
}

function renderRequests(requests, ownerUserId) {
  const tbody = $('#requestsTable tbody');
  if (!requests.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No requests yet.</td></tr>';
    return;
  }
  tbody.innerHTML = requests
    .map((r) => {
      let actions = '';
      if (r.status === 'requires_approval' || r.status === 'pending') {
        actions = `<div class="row-actions">
          <button class="btn small success" data-act="approve" data-id="${r.id}">Approve</button>
          <button class="btn small danger" data-act="reject" data-id="${r.id}">Reject</button>
        </div>`;
      } else if (r.status === 'approved') {
        actions = `<button class="btn small" data-act="execute" data-id="${r.id}">Execute</button>`;
      } else {
        actions = '<span class="muted">—</span>';
      }
      const merchantCell = r.merchant_url
        ? `<a href="${r.merchant_url}" target="_blank" rel="noopener">${r.merchant_name}</a>`
        : r.merchant_name;
      return `<tr>
        <td>${merchantCell}</td>
        <td>${fmt(r.amount, r.currency)}</td>
        <td>${badge(r.status)}</td>
        <td class="muted">${r.decision_reason || ''}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('button[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => handleAction(btn.dataset.act, btn.dataset.id, ownerUserId)),
  );
}

function renderTxns(txns) {
  const tbody = $('#txnTable tbody');
  tbody.innerHTML = !txns.length
    ? '<tr><td colspan="5" class="empty">No transactions yet.</td></tr>'
    : txns
        .map(
          (t) => `<tr>
        <td>${t.merchant_name}</td>
        <td>${fmt(t.amount, t.currency)}</td>
        <td>${badge(t.status)}</td>
        <td class="muted">${t.provider_transaction_id || '—'}</td>
        <td class="muted">${new Date(t.created_at).toLocaleString()}</td>
      </tr>`,
        )
        .join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function handleAction(act, requestId, ownerUserId) {
  try {
    if (act === 'approve') {
      const note = prompt('Approval note (optional):') || undefined;
      await api('POST', `/tools/payments/${requestId}/approve`, { owner_user_id: ownerUserId, note });
    } else if (act === 'reject') {
      const note = prompt('Rejection note (optional):') || undefined;
      await api('POST', `/tools/payments/${requestId}/reject`, { owner_user_id: ownerUserId, note });
    } else if (act === 'execute') {
      await api('POST', `/tools/payments/${requestId}/execute`, null, {
        'Idempotency-Key': `ui:${requestId}`,
      });
    }
    await refresh();
  } catch (e) {
    alert(`${act} failed: ${e.message}`);
  }
}

$('#attachBtn').addEventListener('click', async () => {
  try {
    await api('POST', `/agents/${currentAgent}/payment-identity`);
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

$('#promptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#promptInput').value.trim();
  if (!prompt) return;
  const out = $('#promptResult');
  out.innerHTML = '<span class="muted">Interpreting…</span>';
  try {
    const res = await api('POST', '/tools/payments/request-purchase-from-text', {
      agent_id: currentAgent,
      prompt,
    });
    const p = res.parsed || {};
    const merchantLink = p.merchant_url
      ? `<a href="${p.merchant_url}" target="_blank" rel="noopener">${p.merchant_name}</a>`
      : p.merchant_name;
    const est = p.price_estimated ? ' <span class="muted">(est.)</span>' : '';
    out.innerHTML =
      `<div class="muted" style="margin-bottom:6px">Parsed by <b>${p.parsed_by || '?'}</b>: ` +
      `${merchantLink} · ${fmt(p.amount, p.currency)}${est}` +
      (p.item ? ` · ${p.item}` : '') +
      `</div>` +
      `<pre>${JSON.stringify({ request_id: res.request_id, status: res.status, decision_reason: res.decision_reason }, null, 2)}</pre>`;
    $('#promptInput').value = '';
    await refresh();
  } catch (err) {
    out.innerHTML = `<pre>${JSON.stringify(err.json || { error: err.message }, null, 2)}</pre>`;
  }
});

$('#requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    agent_id: currentAgent,
    merchant_name: f.get('merchant_name'),
    amount: Number(f.get('amount')),
    currency: f.get('currency'),
    purpose: f.get('purpose'),
  };
  try {
    const res = await api('POST', '/tools/payments/request-purchase', body);
    $('#requestResult').innerHTML = `<pre>${JSON.stringify(res, null, 2)}</pre>`;
    await refresh();
  } catch (e) {
    $('#requestResult').innerHTML = `<pre>${JSON.stringify(e.json || { error: e.message }, null, 2)}</pre>`;
  }
});

// ── Refresh ─────────────────────────────────────────────────────────────────
async function refresh() {
  if (!currentAgent) return;
  currentActivity = await api('GET', `/agents/${currentAgent}/payment-activity`);
  const owner = currentActivity.agent?.owner_user_id;
  renderIdentity(currentActivity.agent);
  renderPaymentIdentity(currentActivity.payment_identity);
  renderPolicy(currentActivity.policy);
  renderRequests(currentActivity.purchase_requests, owner);
  renderTxns(currentActivity.transactions);
}

(async function init() {
  await loadAgents();
  await refresh();
})();
