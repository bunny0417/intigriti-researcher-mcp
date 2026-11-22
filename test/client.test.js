import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ClientError, ResearcherClient } from '../src/client.js';

const programId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const token = 'synthetic-token-never-send';
const upstreamSecret = 'sensitive-upstream-text';
const base = 'https://api.intigriti.com/external/researcher/v1/';

function rejectsWith(promise, code) {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes(upstreamSecret));
    return true;
  });
}

async function loopbackTransport(t, handler) {
  const fixture = createServer(handler);
  await new Promise((resolve, reject) => fixture.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => {
    const closed = new Promise(resolve => fixture.close(resolve));
    fixture.closeAllConnections();
    return closed;
  });
  // Map only this test's transport to loopback. The production API origin stays fixed.
  const origin = 'http://127.0.0.1:' + fixture.address().port;
  return (url, init) => fetch(origin + url.pathname + url.search, init);
}

test('six operations use the exact researcher routes and preserve native JSON shapes', async () => {
  const cases = [
    ['listPrograms', [{ statusId: 3, typeId: 1, following: false, limit: 20, offset: 0 }], 'programs?statusId=3&typeId=1&following=false&limit=20&offset=0', { maxCount: 4, records: [] }],
    ['getProgram', [programId], `programs/${programId}`, { id: programId, rulesOfEngagement: null }],
    ['listActivities', [{ createdSince: 0, following: true, limit: 5, offset: 5 }], 'programs/activities?createdSince=0&following=true&limit=5&offset=5', { maxCount: 9, records: [{ programId }] }],
    ['getScopeVersion', [programId, versionId], `programs/${programId}/domains/${versionId}`, { domains: { id: versionId, content: null } }],
    ['getRulesVersion', [programId, versionId], `programs/${programId}/rules-of-engagements/${versionId}`, { rulesOfEngagement: { id: versionId, attachments: [] } }],
    ['listPayouts', [{ statusId: 2, paidSince: 3, createdSince: 1, limit: 10, offset: 2 }], 'payouts?statusId=2&paidSince=3&createdSince=1&limit=10&offset=2', { maxCount: 3, records: [{ paidAt: null }] }],
  ];
  for (const [method, args, path, data] of cases) {
    let sent;
    const client = new ResearcherClient({ token, fetchImpl: (url, init) => {
      sent = { url, init };
      return Response.json(data);
    } });
    assert.deepEqual(await client[method](...args), data);
    assert.equal(sent.url.href, base + path);
    assert.equal(sent.init.headers.Authorization, 'Bearer ' + token);
    assert.equal(sent.init.headers.Accept, 'application/json');
    assert.equal(sent.init.method, 'GET');
    assert.equal(sent.init.redirect, 'manual');
  }
});

test('missing or malformed token and unsupported routes or filters fail before transport', async () => {
  let count = 0;
  const fetchImpl = () => { count += 1; return Response.json({}); };
  for (const value of [undefined, '', 'bad\r\ntoken', 'secret\n']) {
    const client = new ResearcherClient({ token: value, fetchImpl });
    await rejectsWith(client.listPrograms(), 'configuration');
  }
  const client = new ResearcherClient({ token, fetchImpl });
  for (const id of ['../activities', 'https://untrusted.invalid', programId + '\n']) {
    await rejectsWith(client.getProgram(id), 'invalid_input');
    await rejectsWith(client.getScopeVersion(programId, id), 'invalid_input');
  }
  await rejectsWith(client.listPrograms({ following: 'false' }), 'invalid_input');
  await rejectsWith(client.listPrograms({ offset: -1 }), 'invalid_input');
  await rejectsWith(client.listPayouts({ following: true }), 'invalid_input');
  await rejectsWith(client.listActivities({ paidSince: 0 }), 'invalid_input');
  await rejectsWith(client.listActivities({ limit: 501 }), 'invalid_input');
  await rejectsWith(client.listActivities({ createdSince: Infinity }), 'invalid_input');
  assert.equal(count, 0);
});

test('native fetch refuses redirects and aborts a stalled response body', async t => {
  const paths = [];
  const fetchImpl = await loopbackTransport(t, (request, response) => {
    paths.push(request.url);
    if (request.url.endsWith('/activities')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    } else {
      response.writeHead(302, { location: '/' + upstreamSecret }).end();
    }
  });
  const client = new ResearcherClient({ token, timeoutMs: 500, fetchImpl });
  await rejectsWith(client.listPrograms(), 'redirect');
  await rejectsWith(client.listActivities(), 'timeout');
  assert.deepEqual(paths, ['/external/researcher/v1/programs', '/external/researcher/v1/programs/activities']);
});

test('native fetch rejects truncated transfers and enforces the limit after decompression', async t => {
  const compressed = gzipSync(JSON.stringify({ text: 'a'.repeat(4096) }));
  assert.ok(compressed.length < 256);
  const fetchImpl = await loopbackTransport(t, (request, response) => {
    if (request.url.endsWith('/activities')) {
      response.writeHead(200, { 'content-length': 100 });
      response.write('{"records":[]}', () => response.destroy());
    } else if (request.url.endsWith('/payouts')) {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
      response.end(compressed);
    } else {
      response.end('{"records":[]}');
    }
  });
  const client = new ResearcherClient({ token, fetchImpl, maxResponseBytes: 256 });
  await rejectsWith(client.listActivities(), 'connection');
  await rejectsWith(client.listPayouts(), 'response_too_large');
  assert.deepEqual(await client.listPrograms(), { records: [] });
});

test('error bodies, transport exceptions and JSON parser errors are sanitized', async () => {
  const secretText = upstreamSecret + ' ' + token;
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [500, 'upstream_error'], [200, 'invalid_response']]) {
    const client = new ResearcherClient({ token, fetchImpl: () => new Response(secretText, { status }) });
    await rejectsWith(client.listPrograms(), code);
  }
  for (const value of [[], null, 'hello']) {
    const client = new ResearcherClient({ token, fetchImpl: () => Response.json(value) });
    await rejectsWith(client.listPrograms(), 'invalid_response');
  }
  const client = new ResearcherClient({ token, fetchImpl: () => { throw new Error(secretText); } });
  await rejectsWith(client.listPrograms(), 'connection');
});

test('body limit checks the actual bytes even without a Content-Length', async () => {
  const client = new ResearcherClient({ token, maxResponseBytes: 8, fetchImpl: () => new Response('{"size": 123}') });
  await rejectsWith(client.listPrograms(), 'response_too_large');
});

test('returns UTF-8 JSON with a BOM, rejects corrupt text inside an otherwise valid object', async () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"é"}')]);
  const valid = new ResearcherClient({ token, fetchImpl: () => new Response(withBom) });
  assert.deepEqual(await valid.listPrograms(), { name: 'é' });
  const malformed = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const corrupt = new ResearcherClient({ token, fetchImpl: () => new Response(malformed) });
  await rejectsWith(corrupt.listPrograms(), 'invalid_response');
});

test('a partial or accepted response cannot be mistaken for a complete researcher API page', async () => {
  for (const status of [202, 206]) {
    const client = new ResearcherClient({ token, fetchImpl: () => Response.json({ maxCount: 1, records: [] }, { status }) });
    await rejectsWith(client.listPrograms(), 'upstream_error');
  }
});

test('429, Retry-After dates and rate-related 403s share a cooldown across routes', async () => {
  for (const [status, retryAfter, waitMs] of [[429, '4', 4000], [429, null, 300000], [429, '1 GMT', 300000], [429, 'Thu Jan  1 00:00:04 1970', 4000], [403, 'Thu, 01 Jan 1970 00:00:05 GMT', 5000]]) {
    let now = 0;
    let calls = 0;
    const client = new ResearcherClient({ token, now: () => now, fetchImpl: () => {
      calls += 1;
      if (calls > 1) return Response.json({});
      const headers = retryAfter ? { 'retry-after': retryAfter } : {};
      return new Response(upstreamSecret, { status, headers });
    } });
    await rejectsWith(client.listPrograms(), 'rate_limited');
    now = waitMs - 1;
    await rejectsWith(client.listPayouts(), 'rate_limited');
    assert.equal(calls, 1);
    now = waitMs;
    await client.listPayouts();
    assert.equal(calls, 2);
  }
});

test('503 Retry-After applies across routes even when a shorter 429 arrives afterwards', async () => {
  const pending = [];
  let calls = 0;
  let now = 0;
  const client = new ResearcherClient({ token, now: () => now, fetchImpl: () => {
    calls += 1;
    if (calls <= 2) return new Promise(resolve => pending.push(resolve));
    return Response.json({});
  } });
  const first = client.listPrograms();
  const second = client.listPayouts();
  pending[1](new Response(null, { status: 503, headers: { 'retry-after': '10' } }));
  await rejectsWith(second, 'unavailable');
  pending[0](new Response(null, { status: 429, headers: { 'retry-after': '2' } }));
  await rejectsWith(first, 'unavailable');
  now = 9_999;
  await rejectsWith(client.listActivities(), 'unavailable');
  assert.equal(calls, 2);
  now = 10_000;
  await client.listActivities();
  assert.equal(calls, 3);
});

test('plain 403 explains visibility, terms and rate limits while preserving access to other routes', async () => {
  let calls = 0;
  const client = new ResearcherClient({ token, fetchImpl: () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 403 }) : Response.json({});
  } });
  await assert.rejects(client.getProgram(programId), /access.*terms.*limit/);
  await client.listPrograms();
  assert.equal(calls, 2);
});

test('600 calls per rolling five-minute window are shared across operations', async () => {
  let now = 100;
  let calls = 0;
  const client = new ResearcherClient({ token, now: () => now, fetchImpl: () => {
    calls += 1;
    return Response.json({});
  } });
  await Promise.all(Array.from({ length: 600 }, () => client.listPrograms()));
  now += 299_999;
  await rejectsWith(client.listActivities(), 'rate_limited');
  assert.equal(calls, 600);
  now += 1;
  await client.listActivities();
  assert.equal(calls, 601);
});
