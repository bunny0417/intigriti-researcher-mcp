const API_BASE = 'https://api.intigriti.com/external/researcher/v1/';
const WINDOW_MS = 5 * 60_000;
const READS_PER_WINDOW = 600;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_RANGES = {
  limit: [0, 500],
  offset: [0, 2_147_483_647],
  statusId: [-2_147_483_648, 2_147_483_647],
  typeId: [-2_147_483_648, 2_147_483_647],
  createdSince: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  paidSince: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

export class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

function guid(value) {
  if (typeof value !== 'string' || value.length !== 36 || !GUID.test(value)) {
    throw new ClientError('invalid_input', 'Expected a hyphenated GUID for the program or version ID.');
  }
  return value;
}

function validateQuery(query, allowedKeys) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new ClientError('invalid_input', 'Expected an object containing the request filters.');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!allowedKeys.includes(key)) {
      throw new ClientError('invalid_input', 'Unsupported filter for this Intigriti operation.');
    }
    if (value === undefined || value === null) continue;
    if (key === 'following') {
      if (typeof value !== 'boolean') {
        throw new ClientError('invalid_input', 'The following filter must be a boolean.');
      }
    } else {
      const [min, max] = QUERY_RANGES[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new ClientError('invalid_input', 'A numeric Intigriti filter is outside its accepted range.');
      }
    }
    params.set(key, String(value));
  }
  return params;
}

function retryDeadline(header, now) {
  if (header === null) return null;
  if (/^\d+$/.test(header)) {
    const deadline = now + Number(header) * 1000;
    return Number.isSafeInteger(deadline) ? deadline : null;
  }
  // The asctime form of an HTTP date has no timezone suffix, but is always UTC.
  const asctime = /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/.test(header);
  if (!asctime && !/^[A-Za-z]{3,9}, \d\d(?: [A-Za-z]{3} \d{4}|-[A-Za-z]{3}-\d\d) \d\d:\d\d:\d\d GMT$/i.test(header)) return null;
  const deadline = Date.parse(asctime ? header + ' GMT' : header);
  return Number.isFinite(deadline) ? Math.max(deadline, now) : null;
}

function cooldownError(deadline, now, status = 429) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (status === 503) {
    return new ClientError('unavailable', `Intigriti is temporarily unavailable (HTTP 503). Try again in ${seconds} seconds.`);
  }
  return new ClientError('rate_limited', `Intigriti request limit reached. Try again in ${seconds} seconds.`);
}

async function readJson(response, maxBytes) {
  const tooLarge = () => new ClientError('response_too_large', 'The Intigriti response exceeded the local size limit. For list operations, request a smaller page.');
  if (Number(response.headers.get('content-length')) > maxBytes) throw tooLarge();
  if (!response.body) throw new ClientError('invalid_response', 'Intigriti returned an empty response.');

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Native parse errors can contain excerpts from the upstream response.
  }
  throw new ClientError('invalid_response', 'Intigriti returned an invalid JSON object.');
}

export class ResearcherClient {
  #token;
  #fetch;
  #now;
  #timeoutMs;
  #maxResponseBytes;
  #requests = [];
  #cooldown = { until: 0, status: 429 };

  constructor({ token, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  listPrograms(query = {}) {
    return this.#get('programs', query, ['statusId', 'typeId', 'following', 'limit', 'offset']);
  }

  async getProgram(programId) {
    return this.#get(`programs/${guid(programId)}`);
  }

  listActivities(query = {}) {
    return this.#get('programs/activities', query, ['createdSince', 'following', 'limit', 'offset']);
  }

  async getScopeVersion(programId, versionId) {
    return this.#get(`programs/${guid(programId)}/domains/${guid(versionId)}`);
  }

  async getRulesVersion(programId, versionId) {
    return this.#get(`programs/${guid(programId)}/rules-of-engagements/${guid(versionId)}`);
  }

  listPayouts(query = {}) {
    return this.#get('payouts', query, ['statusId', 'createdSince', 'paidSince', 'limit', 'offset']);
  }

  #reserveRequest() {
    const now = this.#now();
    if (now < this.#cooldown.until) throw cooldownError(this.#cooldown.until, now, this.#cooldown.status);
    while (this.#requests.length && this.#requests[0] <= now - WINDOW_MS) {
      this.#requests.shift();
    }
    if (this.#requests.length >= READS_PER_WINDOW) throw cooldownError(this.#requests[0] + WINDOW_MS, now);
    this.#requests.push(now);
  }

  #httpError(response) {
    const now = this.#now();
    const { status } = response;
    if (status === 403 || status === 429 || status === 503) {
      const deadline = retryDeadline(response.headers.get('retry-after'), now);
      if (status === 429 || deadline !== null) {
        const until = deadline ?? now + WINDOW_MS;
        // Requests already in flight can return shorter delays after a longer one arrives.
        if (until >= this.#cooldown.until) this.#cooldown = { until, status };
        return cooldownError(this.#cooldown.until, now, this.#cooldown.status);
      }
      if (status === 503) return new ClientError('unavailable', 'Intigriti is temporarily unavailable (HTTP 503).');
      return new ClientError('forbidden', 'Intigriti denied access. Check program access and current terms in the platform. A 403 can also mean the five-minute request limit was exceeded.');
    }
    if (status === 401) return new ClientError('unauthorized', 'Intigriti rejected the researcher token. Check its value and expiration in account settings.');
    if (status === 404) return new ClientError('not_found', 'Intigriti could not find the requested resource.');
    if (status >= 300 && status < 400) return new ClientError('redirect', 'Intigriti returned a redirect. The request stopped at the configured API.');
    return new ClientError('upstream_error', `Intigriti returned HTTP ${status}.`);
  }

  async #get(path, query = {}, allowedKeys = []) {
    const url = new URL(path, API_BASE);
    url.search = validateQuery(query, allowedKeys).toString();
    if (typeof this.#token !== 'string' || !/^[\x21-\x7e]+$/.test(this.#token) || /\s/.test(this.#token)) {
      throw new ClientError('configuration', 'Set INTIGRITI_API_TOKEN in the MCP project .env file or process environment, then restart the connector.');
    }
    this.#reserveRequest();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#token}` },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200) throw this.#httpError(response);
      return await readJson(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (controller.signal.aborted) throw new ClientError('timeout', 'The Intigriti request timed out.');
      throw new ClientError('connection', 'Could not read the response from the Intigriti API.');
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
    }
  }
}
