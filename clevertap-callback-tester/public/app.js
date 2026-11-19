(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const MAX_HISTORY = 50;
  const CLIENT_TIMEOUT_MS = 25000;

  const state = {
    templates: null, // { channels: { key: { label, statuses: [{key,label,description}] } } }
    channel: 'sms',
    busy: false,
    history: [], // newest first, memory only
    nextId: 1,
  };

  const els = {
    tabs: $('#tabs'),
    url: $('#callbackUrl'),
    msgId: $('#msgId'),
    msgIdHint: $('#msgIdHint'),
    buttons: $('#statusButtons'),
    formError: $('#formError'),
    previewDetails: $('#previewDetails'),
    previewStatus: $('#previewStatus'),
    previewOut: $('#previewOut'),
    previewCopy: $('#previewCopy'),
    resultCard: $('#resultCard'),
    result: $('#result'),
    historyBody: $('#historyBody'),
    historyEmpty: $('#historyEmpty'),
    clearHistory: $('#clearHistory'),
  };

  // ---------- tiny DOM helpers (text only, never innerHTML) ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    }
  }

  const channelCfg = () => state.templates.channels[state.channel];

  // ---------- rendering the form ----------
  function renderTabs() {
    els.tabs.replaceChildren();
    for (const [key, cfg] of Object.entries(state.templates.channels)) {
      const tab = el('button', 'tab', cfg.label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(key === state.channel));
      tab.dataset.channel = key;
      tab.addEventListener('click', () => selectChannel(key));
      els.tabs.appendChild(tab);
    }
  }

  function renderStatusButtons() {
    els.buttons.replaceChildren();
    for (const s of channelCfg().statuses) {
      const btn = el('button', 'btn');
      btn.type = 'button';
      btn.dataset.status = s.key;
      btn.title = s.description || s.label;
      btn.appendChild(el('span', 'btn-label', s.label));
      btn.addEventListener('click', () => send(s.key, btn));
      els.buttons.appendChild(btn);
    }
    els.previewStatus.replaceChildren();
    for (const s of channelCfg().statuses) {
      const opt = el('option', '', s.label);
      opt.value = s.key;
      els.previewStatus.appendChild(opt);
    }
  }

  const PLACEHOLDERS = {
    sms: {
      url: 'https://cb.wzrkt.com/sms/generic?account=946-KR9-6K7Z',
      msgId: 'ID received from CleverTap, e.g. 918605962596.1736923649.1794480055.20261112.0.wzrk_default.-191529.-1.',
    },
    whatsapp: {
      url: 'https://cb.wzrkt.com/wa/generic/status?a=946-KR9-6K7Z',
      msgId: 'ID received from CleverTap, e.g. 216336|1794298065|20261112|191529|0',
    },
    rcs: {
      url: 'https://cb.wzrkt.com/rcs/generic?account=946-KR9-6K7Z',
      msgId: 'ID received from CleverTap in the outbound RCS message payload',
    },
  };

  function renderHint() {
    const ph = PLACEHOLDERS[state.channel];
    if (ph) {
      els.url.placeholder = ph.url;
      els.msgId.placeholder = ph.msgId;
    }
    const hints = {
      sms: 'For SMS this is the value CleverTap sent in the $$MessageID field. It goes back as "meta".',
      whatsapp: 'For WhatsApp this is the msgId from the outbound message payload. It goes back as "msgId".',
      rcs: 'For RCS this is the msgId from the outbound message payload. It goes back as "meta".',
    };
    els.msgIdHint.textContent = hints[state.channel] || '';
  }

  function selectChannel(key) {
    if (state.busy || key === state.channel) return;
    state.channel = key;
    clearFormError();
    renderTabs();
    renderStatusButtons();
    renderHint();
    refreshPreview();
  }

  function setBusy(busy, activeButton) {
    state.busy = busy;
    for (const btn of els.buttons.querySelectorAll('button')) {
      btn.disabled = busy;
      const spinner = btn.querySelector('.spinner');
      if (spinner) spinner.remove();
    }
    for (const tab of els.tabs.querySelectorAll('button')) tab.disabled = busy;
    if (busy && activeButton) {
      const spinner = el('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      activeButton.prepend(spinner);
    }
    els.buttons.setAttribute('aria-busy', String(busy));
  }

  // ---------- validation ----------
  function showFormError(message, field) {
    els.formError.textContent = message;
    els.formError.hidden = false;
    els.url.removeAttribute('aria-invalid');
    els.msgId.removeAttribute('aria-invalid');
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  function clearFormError() {
    els.formError.hidden = true;
    els.formError.textContent = '';
    els.url.removeAttribute('aria-invalid');
    els.msgId.removeAttribute('aria-invalid');
  }

  function validateInputs() {
    const url = els.url.value.trim();
    const msgId = els.msgId.value.trim();
    if (!url) return { error: 'Enter the callback URL.', field: els.url };
    let parsed;
    try { parsed = new URL(url); } catch { return { error: 'The callback URL is not a valid URL. Include https://', field: els.url }; }
    if (parsed.protocol !== 'https:') return { error: 'The callback URL must start with https://', field: els.url };
    if (!msgId) return { error: 'Enter the msgId you received from CleverTap.', field: els.msgId };
    return { url, msgId };
  }

  // ---------- API ----------
  async function api(path, payload, timeoutMs = CLIENT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      return { httpOk: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(statusKey, button) {
    if (state.busy) return;
    clearFormError();
    const input = validateInputs();
    if (input.error) { showFormError(input.error, input.field); return; }

    setBusy(true, button);
    const label = channelCfg().statuses.find((s) => s.key === statusKey).label;
    const entry = {
      id: state.nextId++,
      at: new Date(),
      channel: state.channel,
      channelLabel: channelCfg().label,
      status: statusKey,
      statusLabel: label,
      msgId: input.msgId,
    };
    try {
      const { httpOk, data, status } = await api('/api/send', {
        channel: state.channel,
        status: statusKey,
        callbackUrl: input.url,
        msgId: input.msgId,
      });
      if (httpOk && data && data.result) {
        const r = data.result;
        entry.kind = r.response.status < 300 ? 'ok' : r.response.status < 400 ? 'warn' : 'bad';
        entry.summary = `${r.response.status} ${r.response.statusText}`.trim();
        entry.durationMs = r.durationMs;
        entry.result = r;
      } else {
        const err = (data && data.error) || { code: 'ERROR', message: `Unexpected response (HTTP ${status})` };
        entry.kind = 'bad';
        entry.summary = err.code;
        entry.error = err;
      }
    } catch (e) {
      entry.kind = 'bad';
      entry.summary = 'NETWORK';
      entry.error = {
        code: 'NETWORK',
        message: e.name === 'AbortError'
          ? 'The tester did not answer in time.'
          : 'Could not reach the tester server. Is it still running?',
      };
    } finally {
      setBusy(false);
    }
    addHistory(entry);
    renderResult(entry);
  }

  // ---------- result ----------
  function prettyBody(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  function section(title, content, { open = true, copyValue = null } = {}) {
    const details = el('details', 'section');
    details.open = open;
    const summary = el('summary', '', title);
    details.appendChild(summary);
    if (copyValue !== null) {
      const bar = el('div', 'section-bar');
      const btn = el('button', 'btn ghost', 'Copy');
      btn.type = 'button';
      btn.addEventListener('click', () => copyText(copyValue, btn));
      bar.appendChild(btn);
      details.appendChild(bar);
    }
    const pre = el('pre', 'code', content);
    pre.tabIndex = 0;
    details.appendChild(pre);
    return details;
  }

  function headersText(headers) {
    const lines = Object.entries(headers || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    return lines.length ? lines.join('\n') : '(none)';
  }

  function renderResult(entry) {
    els.resultCard.hidden = false;
    els.result.replaceChildren();

    const head = el('div', `result-head ${entry.kind}`);
    if (entry.result) {
      head.appendChild(el('span', 'result-title', `HTTP ${entry.result.response.status} ${entry.result.response.statusText}`.trim()));
      head.appendChild(el('span', 'result-meta', `${entry.durationMs} ms · ${entry.channelLabel} ${entry.statusLabel}`));
    } else {
      head.appendChild(el('span', 'result-title', errorTitle(entry.error.code)));
      head.appendChild(el('span', 'result-meta', `${entry.channelLabel} ${entry.statusLabel}`));
    }
    els.result.appendChild(head);

    if (entry.result) {
      const r = entry.result;
      if (r.note) els.result.appendChild(el('p', 'result-msg', r.note));
      else if (entry.kind === 'bad') els.result.appendChild(el('p', 'result-msg', `The callback server answered with a non-2xx status (${r.response.status}).`));
      if (r.profileUrl) {
        const box = el('div', 'profile-link');
        box.appendChild(el('strong', '', 'Profile where this event is recorded'));
        const a = el('a', 'mono', r.profileUrl);
        a.href = r.profileUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        box.appendChild(a);
        const copy = el('button', 'btn ghost', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', () => copyText(r.profileUrl, copy));
        box.appendChild(copy);
        els.result.appendChild(box);
      }
      els.result.appendChild(section('Request sent (curl)', r.request.curl, { copyValue: r.request.curl }));
      els.result.appendChild(section('Response headers', headersText(r.response.headers), { open: false }));
      let body = r.response.body ? prettyBody(r.response.body) : '(empty body)';
      if (r.response.truncated) body += `\n\n… response truncated after ${r.response.bytes} bytes`;
      els.result.appendChild(section('Response body', body));
    } else {
      els.result.appendChild(el('p', 'result-msg', entry.error.message));
      if (entry.error.request) {
        els.result.appendChild(section('Request that was prepared (curl)', entry.error.request.curl, { copyValue: entry.error.request.curl }));
      }
    }
    els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function errorTitle(code) {
    const titles = {
      INVALID_URL: 'Invalid callback URL',
      INVALID_MSG_ID: 'Invalid msgId',
      BLOCKED_ADDRESS: 'Address not allowed',
      DNS_FAILURE: 'DNS lookup failed',
      TIMEOUT: 'Timed out',
      TLS_ERROR: 'TLS error',
      CONNECTION_ERROR: 'Connection failed',
      RATE_LIMITED: 'Rate limited',
      NETWORK: 'Tester unreachable',
    };
    return titles[code] || `Error (${code})`;
  }

  // ---------- history ----------
  function addHistory(entry) {
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    renderHistory();
  }

  function renderHistory() {
    els.historyBody.replaceChildren();
    els.historyEmpty.hidden = state.history.length > 0;
    for (const e of state.history) {
      const tr = el('tr');
      tr.tabIndex = 0;
      tr.appendChild(el('td', '', e.at.toLocaleTimeString()));
      tr.appendChild(el('td', '', e.channelLabel));
      tr.appendChild(el('td', '', e.statusLabel));
      const msg = el('td', 'msg mono', e.msgId);
      msg.title = e.msgId;
      tr.appendChild(msg);
      const resp = el('td');
      resp.appendChild(el('span', `pill ${e.kind}`, e.summary));
      tr.appendChild(resp);
      tr.appendChild(el('td', '', e.durationMs !== undefined ? `${e.durationMs} ms` : '—'));
      const show = () => renderResult(e);
      tr.addEventListener('click', show);
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(); } });
      els.historyBody.appendChild(tr);
    }
  }

  // ---------- preview ----------
  let previewTimer = null;
  let previewCurl = '';
  let previewSeq = 0;

  function refreshPreview() {
    if (!els.previewDetails.open || !state.templates) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const seq = ++previewSeq;
      try {
        const { httpOk, data } = await api('/api/preview', {
          channel: state.channel,
          status: els.previewStatus.value,
          callbackUrl: els.url.value.trim(),
          msgId: els.msgId.value.trim(),
        }, 8000);
        if (seq !== previewSeq) return;
        if (httpOk && data && data.request) {
          const r = data.request;
          previewCurl = r.curl;
          els.previewOut.textContent = `${r.method} ${r.url}\n${headersText(r.headers)}\n\n${JSON.stringify(r.body, null, 2)}`;
        } else {
          previewCurl = '';
          els.previewOut.textContent = (data && data.error && data.error.message) || 'Could not build the preview.';
        }
      } catch {
        if (seq === previewSeq) els.previewOut.textContent = 'Could not reach the tester server.';
      }
    }, 200);
  }

  // ---------- wiring ----------
  els.previewDetails.addEventListener('toggle', refreshPreview);
  els.previewStatus.addEventListener('change', refreshPreview);
  els.url.addEventListener('input', () => { clearFormError(); refreshPreview(); });
  els.msgId.addEventListener('input', () => { clearFormError(); refreshPreview(); });
  els.previewCopy.addEventListener('click', () => { if (previewCurl) copyText(previewCurl, els.previewCopy); });
  els.clearHistory.addEventListener('click', () => {
    state.history = [];
    renderHistory();
    els.resultCard.hidden = true;
    els.result.replaceChildren();
  });

  async function init() {
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) throw new Error('bad status');
      state.templates = await res.json();
    } catch {
      showFormError('Could not load the callback templates from the server.');
      return;
    }
    const keys = Object.keys(state.templates.channels);
    if (!keys.includes(state.channel)) state.channel = keys[0];
    renderTabs();
    renderStatusButtons();
    renderHint();
    renderHistory();
  }

  init();
})();
