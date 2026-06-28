const STORAGE_KEY = "agentid.console.state.v1";

const capabilityMeta = {
  phone: {
    label: "Phone",
    field: "phoneValue",
    eventTitle: "voice.call.received",
    eventBody: identity => `Inbound call routed to ${identity.phone || "unissued phone"} from +1 415 555 ${randomDigits(4)}.`
  },
  email: {
    label: "Email",
    field: "emailValue",
    eventTitle: "email.message.sent",
    eventBody: identity => `Message sent from ${identity.email || "unissued mailbox"} to finance@company.com.`
  },
  card: {
    label: "Payment card",
    field: "cardValue",
    eventTitle: "card.authorization.created",
    eventBody: identity => `$${randomAmount()} authorization approved on ${identity.card || "unissued card"}.`
  },
  calendar: {
    label: "Calendar",
    field: "calendarValue",
    eventTitle: "calendar.event.created",
    eventBody: identity => `Meeting booked on ${identity.calendar || "unissued calendar"} for tomorrow at 10:30.`
  }
};

const defaultState = {
  identity: null,
  events: [],
  selectedSample: "javascript",
  environment: "sandbox"
};

let state = loadState();
let toastTimer = null;

const els = {
  form: document.querySelector("#identityForm"),
  issueButton: document.querySelector("#issueButton"),
  issueState: document.querySelector("#issueState"),
  identityStatus: document.querySelector("#identityStatus"),
  identityCount: document.querySelector("#identityCount"),
  eventCount: document.querySelector("#eventCount"),
  riskScore: document.querySelector("#riskScore"),
  passportAvatar: document.querySelector("#passportAvatar"),
  passportName: document.querySelector("#passportName"),
  passportId: document.querySelector("#passportId"),
  phoneValue: document.querySelector("#phoneValue"),
  emailValue: document.querySelector("#emailValue"),
  cardValue: document.querySelector("#cardValue"),
  calendarValue: document.querySelector("#calendarValue"),
  apiKeyValue: document.querySelector("#apiKeyValue"),
  eventLog: document.querySelector("#eventLog"),
  lastEventState: document.querySelector("#lastEventState"),
  sampleOutput: document.querySelector("#sampleOutput"),
  environmentSelect: document.querySelector("#environmentSelect"),
  toast: document.querySelector("#toast")
};

hydrateForm();
render();

els.form.addEventListener("submit", event => {
  event.preventDefault();
  issueIdentity();
});

document.querySelectorAll("[data-event]").forEach(button => {
  button.addEventListener("click", () => simulateEvent(button.dataset.event));
});

document.querySelectorAll("[data-copy-target]").forEach(button => {
  button.addEventListener("click", () => copyValue(button.dataset.copyTarget));
});

document.querySelectorAll("[data-sample]").forEach(tab => {
  tab.addEventListener("click", () => {
    state.selectedSample = tab.dataset.sample;
    saveState();
    renderSnippets();
    renderTabs();
  });
});

document.querySelector("#clearEventsButton").addEventListener("click", () => {
  state.events = [];
  saveState();
  renderEvents();
  renderMetrics();
  showToast("Webhook events cleared");
});

document.querySelector("#resetButton").addEventListener("click", () => {
  state = { ...defaultState, events: [] };
  localStorage.removeItem(STORAGE_KEY);
  hydrateForm();
  render();
  showToast("Sandbox reset");
});

document.querySelector("#rotateKeyButton").addEventListener("click", () => {
  if (!state.identity) {
    showToast("Issue an identity first");
    return;
  }
  state.identity.apiKey = makeApiKey(state.environment);
  pushEvent("identity.api_key.rotated", "New API key issued for this agent identity.");
  saveState();
  render();
  showToast("API key rotated");
});

document.querySelector("#downloadButton").addEventListener("click", () => {
  if (!state.identity) {
    showToast("Issue an identity first");
    return;
  }
  const payload = JSON.stringify({ identity: state.identity, events: state.events }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.identity.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Identity JSON exported");
});

els.environmentSelect.addEventListener("change", () => {
  state.environment = els.environmentSelect.value;
  if (state.identity) {
    state.identity.environment = state.environment;
    state.identity.apiKey = makeApiKey(state.environment);
    pushEvent("identity.environment.updated", `Environment changed to ${state.environment}.`);
  }
  saveState();
  render();
});

function issueIdentity() {
  const formData = new FormData(els.form);
  const capabilities = formData.getAll("capability");
  const name = cleanString(formData.get("agentName")) || "Untitled Agent";
  const region = formData.get("region");
  const useCase = formData.get("useCase");
  const limit = Number(formData.get("spendLimit")) || 250;
  const domains = cleanString(formData.get("allowedDomains"))
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  const threshold = Number(formData.get("approvalThreshold")) || 0;

  if (!capabilities.length) {
    showToast("Select at least one capability");
    return;
  }

  els.issueButton.disabled = true;
  els.issueState.textContent = "Issuing";

  window.setTimeout(() => {
    const id = `agent_${slugify(name)}_${randomId(6)}`;
    state.identity = {
      id,
      name,
      useCase,
      region,
      environment: state.environment,
      capabilities,
      phone: capabilities.includes("phone") ? makePhone(region) : null,
      email: capabilities.includes("email") ? `${slugify(name)}-${randomId(3)}@agents.example` : null,
      card: capabilities.includes("card") ? `visa_test_${randomDigits(4)}` : null,
      calendar: capabilities.includes("calendar") ? `cal_${slugify(name)}_${randomId(5)}` : null,
      apiKey: makeApiKey(state.environment),
      policy: {
        monthlyLimit: limit,
        approvalThreshold: threshold,
        allowedDomains: domains
      },
      createdAt: new Date().toISOString()
    };
    state.events = [
      makeEvent("identity.created", `${name} received ${capabilities.length} real-world capabilities.`),
      ...state.events
    ].slice(0, 40);
    els.issueButton.disabled = false;
    saveState();
    render();
    showToast("Identity issued");
  }, 420);
}

function simulateEvent(type) {
  if (!state.identity) {
    showToast("Issue an identity first");
    return;
  }

  const capability = type === "payment" ? "card" : type;
  if (!state.identity.capabilities.includes(capability)) {
    showToast(`${capabilityMeta[capability].label} is not enabled`);
    return;
  }

  const meta = capabilityMeta[capability];
  pushEvent(meta.eventTitle, meta.eventBody(state.identity));
  saveState();
  renderEvents();
  renderMetrics();
  renderSnippets();
  showToast("Webhook event delivered");
}

function pushEvent(title, body) {
  state.events = [makeEvent(title, body), ...state.events].slice(0, 40);
  els.lastEventState.textContent = title.split(".")[0];
}

function makeEvent(title, body) {
  return {
    id: `evt_${randomId(10)}`,
    title,
    body,
    at: new Date().toISOString()
  };
}

function render() {
  els.environmentSelect.value = state.environment;
  renderIdentity();
  renderEvents();
  renderMetrics();
  renderTabs();
  renderSnippets();
  renderSimulatorButtons();
}

function renderIdentity() {
  const identity = state.identity;
  const name = identity?.name || document.querySelector("#agentName").value || "Hermes Support Agent";
  els.passportName.textContent = name;
  els.passportAvatar.textContent = name.trim().charAt(0).toUpperCase() || "A";
  els.passportId.textContent = identity?.id || "agent_pending";
  els.identityStatus.textContent = identity ? "Issued" : "Not issued";
  els.issueState.textContent = identity ? "Issued" : "Draft";

  setCredential("phone", identity?.phone);
  setCredential("email", identity?.email);
  setCredential("card", identity?.card);
  setCredential("calendar", identity?.calendar);
  els.apiKeyValue.textContent = identity?.apiKey || "sk_test_pending";

  document.querySelectorAll(".credential-row").forEach(row => {
    const capability = row.dataset.capability;
    row.classList.toggle("is-disabled", !identity?.capabilities?.includes(capability));
  });
}

function setCredential(capability, value) {
  const field = capabilityMeta[capability].field;
  els[field].textContent = value || "Not issued";
}

function renderEvents() {
  if (!state.events.length) {
    els.eventLog.innerHTML = `<li><time>--:--:--</time><div><strong>No events yet</strong><span>Issue an identity or run the simulator.</span></div></li>`;
    els.lastEventState.textContent = "Idle";
    return;
  }

  els.eventLog.innerHTML = state.events.map(event => {
    const time = new Date(event.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    return `<li><time>${escapeHtml(time)}</time><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.body)}</span></div></li>`;
  }).join("");
  els.lastEventState.textContent = state.events[0].title.split(".")[0];
}

function renderMetrics() {
  els.identityCount.textContent = state.identity ? "1" : "0";
  els.eventCount.textContent = String(state.events.length);
  const limit = state.identity?.policy?.monthlyLimit || 0;
  const approval = state.identity?.policy?.approvalThreshold || 0;
  const hasPayment = state.identity?.capabilities?.includes("card");
  els.riskScore.textContent = hasPayment && limit > 1000 && approval > 250 ? "Med" : "Low";
}

function renderSimulatorButtons() {
  document.querySelectorAll("[data-event]").forEach(button => {
    const capability = button.dataset.event === "payment" ? "card" : button.dataset.event;
    button.disabled = Boolean(state.identity) && !state.identity.capabilities.includes(capability);
  });
}

function renderTabs() {
  document.querySelectorAll("[data-sample]").forEach(tab => {
    const selected = tab.dataset.sample === state.selectedSample;
    tab.classList.toggle("is-selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
}

function renderSnippets() {
  els.sampleOutput.textContent = getSample(state.selectedSample);
}

function getSample(kind) {
  const identity = state.identity || placeholderIdentity();
  const capabilitiesJson = JSON.stringify(identity.capabilities);

  if (kind === "curl") {
    return `curl https://api.agentid.dev/v1/agent-identities \\
  -H "Authorization: Bearer ${identity.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "${identity.name}",
    "region": "${identity.region}",
    "capabilities": ${capabilitiesJson},
    "policy": {
      "monthly_limit": ${identity.policy.monthlyLimit},
      "approval_threshold": ${identity.policy.approvalThreshold}
    }
  }'`;
  }

  if (kind === "policy") {
    return JSON.stringify({
      identity_id: identity.id,
      environment: identity.environment,
      capabilities: identity.capabilities,
      payment_controls: {
        monthly_limit: identity.policy.monthlyLimit,
        approval_threshold: identity.policy.approvalThreshold
      },
      communication_controls: {
        allowed_domains: identity.policy.allowedDomains
      },
      webhook: {
        url: "https://your-agent.example/webhooks/agentid",
        events: ["voice.*", "email.*", "card.*", "calendar.*"]
      }
    }, null, 2);
  }

  return `import { AgentID } from "@agentid/sdk";

const client = new AgentID({
  apiKey: "${identity.apiKey}"
});

const identity = await client.identities.create({
  name: "${identity.name}",
  region: "${identity.region}",
  capabilities: ${capabilitiesJson},
  policy: {
    monthlyLimit: ${identity.policy.monthlyLimit},
    approvalThreshold: ${identity.policy.approvalThreshold},
    allowedDomains: ${JSON.stringify(identity.policy.allowedDomains)}
  }
});

await agent.use(identity.tools());`;
}

function hydrateForm() {
  const identity = state.identity;
  els.environmentSelect.value = state.environment;
  if (!identity) return;

  document.querySelector("#agentName").value = identity.name;
  document.querySelector("#useCase").value = identity.useCase;
  document.querySelector("#region").value = identity.region;
  document.querySelector("#spendLimit").value = identity.policy.monthlyLimit;
  document.querySelector("#approvalThreshold").value = identity.policy.approvalThreshold;
  document.querySelector("#allowedDomains").value = identity.policy.allowedDomains.join(", ");
  document.querySelectorAll("[name='capability']").forEach(input => {
    input.checked = identity.capabilities.includes(input.value);
  });
}

function copyValue(targetId) {
  const value = document.getElementById(targetId).textContent;
  if (!value || value === "Not issued") {
    showToast("Nothing to copy");
    return;
  }

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(() => showToast("Copied"));
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  showToast("Copied");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 1800);
}

function placeholderIdentity() {
  return {
    id: "agent_pending",
    name: "Hermes Support Agent",
    region: "US",
    environment: state.environment,
    capabilities: ["phone", "email", "card", "calendar"],
    apiKey: "sk_test_pending",
    policy: {
      monthlyLimit: 250,
      approvalThreshold: 100,
      allowedDomains: ["company.com", "customer.io"]
    }
  };
}

function makePhone(region) {
  if (region === "EU") return `+33 1 ${randomDigits(2)} ${randomDigits(2)} ${randomDigits(2)} ${randomDigits(2)}`;
  if (region === "GB") return `+44 20 ${randomDigits(4)} ${randomDigits(4)}`;
  return `+1 415 555 ${randomDigits(4)}`;
}

function makeApiKey(environment) {
  const prefix = environment === "live" ? "sk_live" : "sk_test";
  return `${prefix}_${randomId(24)}`;
}

function randomAmount() {
  return (Math.floor(Math.random() * 165) + 18).toFixed(2);
}

function randomDigits(length) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function randomId(length) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28) || "agent";
}

function cleanString(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      ...defaultState,
      ...saved,
      events: Array.isArray(saved?.events) ? saved.events : []
    };
  } catch {
    return { ...defaultState, events: [] };
  }
}
