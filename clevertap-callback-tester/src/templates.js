'use strict';

const fs = require('node:fs');
const { AppError } = require('./errors');

const KNOWN_PLACEHOLDERS = new Set(['CALLBACK_URL', 'MSG_ID', 'TIMESTAMP']);
const TOKEN = /\{\{\s*([A-Z_]+)(?::([a-z]+))?\s*\}\}/g;
const WHOLE = /^\{\{\s*([A-Z_]+)(?::([a-z]+))?\s*\}\}$/;

class TemplateError extends AppError {
  constructor(message, code = 'TEMPLATE_ERROR', status = 500) {
    super(code, message, status);
    this.name = 'TemplateError';
  }
}

function resolveToken(name, ctx) {
  if (!KNOWN_PLACEHOLDERS.has(name)) {
    throw new TemplateError(`Unknown placeholder {{${name}}} in templates.json`);
  }
  const values = { CALLBACK_URL: ctx.callbackUrl, MSG_ID: ctx.msgId, TIMESTAMP: ctx.timestamp };
  const value = values[name];
  if (value === undefined || value === null || value === '') {
    throw new TemplateError(`No value available for placeholder {{${name}}}`);
  }
  return value;
}

/**
 * Walks a parsed JSON value and replaces placeholders inside string values.
 * Because substitution happens on the parsed structure (never on raw JSON text),
 * a msgId containing quotes or backslashes cannot break out of its string.
 *
 *  - "{{MSG_ID}}", "prefix-{{MSG_ID}}"  -> string substitution
 *  - "{{TIMESTAMP}}"                    -> string "1647441774"
 *  - "{{TIMESTAMP:number}}"             -> number 1647441774 (whole-value only)
 */
function substitute(value, ctx) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      const resolved = resolveToken(whole[1], ctx);
      if (whole[2] === undefined) return String(resolved);
      if (whole[2] === 'number') {
        const n = Number(resolved);
        if (!Number.isFinite(n)) {
          throw new TemplateError(`{{${whole[1]}:number}} resolved to a non-numeric value`);
        }
        return n;
      }
      throw new TemplateError(`Unsupported placeholder type ":${whole[2]}"`);
    }
    return value.replace(TOKEN, (_m, name, type) => {
      if (type) {
        throw new TemplateError(`Placeholder type ":${type}" is only allowed when the placeholder is the whole string value`);
      }
      return String(resolveToken(name, ctx));
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, { value: substitute(v, ctx), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateTemplates(doc) {
  if (!doc || typeof doc !== 'object' || !doc.channels || typeof doc.channels !== 'object') {
    throw new TemplateError('templates.json must contain a "channels" object');
  }
  const channelKeys = Object.keys(doc.channels);
  if (channelKeys.length === 0) throw new TemplateError('templates.json has no channels');
  for (const [ck, channel] of Object.entries(doc.channels)) {
    if (!channel || typeof channel.label !== 'string' || !channel.statuses || typeof channel.statuses !== 'object') {
      throw new TemplateError(`Channel "${ck}" needs a "label" and a "statuses" object`);
    }
    const statusKeys = Object.keys(channel.statuses);
    if (statusKeys.length === 0) throw new TemplateError(`Channel "${ck}" has no statuses`);
    for (const [sk, status] of Object.entries(channel.statuses)) {
      const where = `${ck}.${sk}`;
      if (!status || typeof status.label !== 'string') throw new TemplateError(`Status "${where}" needs a "label"`);
      const req = status.request;
      if (!req || typeof req !== 'object') throw new TemplateError(`Status "${where}" needs a "request" object`);
      if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
        throw new TemplateError(`Status "${where}" request.method must be POST, PUT or PATCH`);
      }
      if (req.headers !== undefined && (typeof req.headers !== 'object' || Array.isArray(req.headers))) {
        throw new TemplateError(`Status "${where}" request.headers must be an object`);
      }
      if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
        throw new TemplateError(`Status "${where}" request.body must be a JSON object or array`);
      }
      if (!JSON.stringify(req.body).includes('{{MSG_ID}}')) {
        throw new TemplateError(`Status "${where}" request.body never uses {{MSG_ID}}`);
      }
    }
  }
  return doc;
}

function loadTemplatesFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new TemplateError(`Cannot read templates file: ${e.code || e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new TemplateError(`templates.json is not valid JSON: ${e.message}`);
  }
  return validateTemplates(doc);
}

/**
 * Loads templates.json and transparently reloads it when the file changes,
 * so templates can be edited without restarting the server.
 * A broken edit is reported on the next request instead of crashing the process.
 */
function createTemplateStore(file) {
  let cached = loadTemplatesFile(file); // fail fast on startup
  let mtime = fs.statSync(file).mtimeMs;
  return {
    get() {
      let current;
      try {
        current = fs.statSync(file).mtimeMs;
      } catch (e) {
        throw new TemplateError(`Cannot read templates file: ${e.code || e.message}`);
      }
      if (current !== mtime) {
        cached = loadTemplatesFile(file);
        mtime = current;
      }
      return cached;
    },
  };
}

function listTemplates(doc) {
  const channels = {};
  for (const [ck, channel] of Object.entries(doc.channels)) {
    channels[ck] = {
      label: channel.label,
      docs: channel.docs || null,
      statuses: Object.entries(channel.statuses).map(([sk, s]) => ({
        key: sk,
        label: s.label,
        description: s.description || '',
      })),
    };
  }
  return { channels };
}

/** Returns { method, headers, body } with every placeholder replaced. */
function buildRequest(doc, channel, status, ctx) {
  if (typeof channel !== 'string' || !hasOwn(doc.channels, channel)) {
    throw new TemplateError(`Unknown channel "${String(channel).slice(0, 40)}"`, 'UNKNOWN_TEMPLATE', 400);
  }
  const statuses = doc.channels[channel].statuses;
  if (typeof status !== 'string' || !hasOwn(statuses, status)) {
    throw new TemplateError(`Unknown status "${String(status).slice(0, 40)}" for channel "${channel}"`, 'UNKNOWN_TEMPLATE', 400);
  }
  const tpl = statuses[status].request;
  return {
    method: tpl.method,
    headers: substitute(tpl.headers || {}, ctx),
    body: substitute(tpl.body, ctx),
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Builds a copy-pasteable curl command that matches the request exactly. */
function toCurl({ method, url, headers, bodyText }) {
  const lines = [`curl -X ${method} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers || {})) {
    lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  lines.push(`  --data-raw ${shellQuote(bodyText)}`);
  return lines.join(' \\\n');
}

module.exports = {
  TemplateError,
  substitute,
  validateTemplates,
  loadTemplatesFile,
  createTemplateStore,
  listTemplates,
  buildRequest,
  toCurl,
};
