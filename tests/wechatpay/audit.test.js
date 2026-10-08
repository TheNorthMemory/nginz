import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { startNginz, stopNginz, cleanupRuntime, createHTTPMock, TEST_URL } from '../harness.js';
import { signedUpstreamResponse, verifyProxyAuthorization } from '../mocks/wechatpay.js';

const privateKey = readFileSync('tests/wechatpay/fixtures/test_private.pem', 'utf8');
const publicKey = readFileSync('tests/wechatpay/fixtures/test_public.pem', 'utf8');
const responseBody = '{"code":"ORDER_NOT_EXIST"}';
let mock;

// These bounded regression inputs target only loopback nginx and synthetic
// provider fixtures; never point this suite at a deployed payment service.
if (new URL(TEST_URL).hostname !== 'localhost' && new URL(TEST_URL).hostname !== '127.0.0.1') {
    throw new Error('payment body regressions require a loopback fixture');
}

function direct(method, body, headers = {}, path = '/proxy-audit?mchid=test') {
    if (headers['Transfer-Encoding'] === 'chunked') {
        const bytes = Buffer.from(body || '');
        const wire = Buffer.concat([
            Buffer.from(method + ' ' + path + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n'),
            ...(bytes.length ? [Buffer.from(bytes.length.toString(16) + '\r\n'), bytes, Buffer.from('\r\n')] : []),
            Buffer.from('0\r\n\r\n'),
        ]);
        return rawRequest(wire).then(reply => ({
            status: Number(reply.match(/^HTTP\/1\.1 (\d+)/)?.[1]),
            body: responseText(reply),
        }));
    }
    return new Promise((resolve, reject) => {
        const req = http.request(TEST_URL + path, { method, agent: false, headers: {
            Connection: 'close', ...headers,
        } }, (res) => {
            const parts = [];
            res.on('data', part => parts.push(part));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
            res.on('error', reject);
        });
        req.setTimeout(3000, () => req.destroy(new Error('audited request timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

function responseText(reply) {
    const boundary = reply.indexOf('\r\n\r\n');
    const body = reply.slice(boundary + 4);
    if (!/\r\nTransfer-Encoding: chunked/i.test(reply.slice(0, boundary))) return body;
    let offset = 0, decoded = '';
    for (;;) {
        const end = body.indexOf('\r\n', offset);
        if (end < 0) throw new Error('incomplete response chunk size');
        const size = Number.parseInt(body.slice(offset, end), 16);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid response chunk size');
        if (size === 0) return decoded;
        offset = end + 2;
        if (body.slice(offset + size, offset + size + 2) !== '\r\n') throw new Error('incomplete response chunk');
        decoded += body.slice(offset, offset + size);
        offset += size + 2;
    }
}

async function subrequest(method, body, query = '') {
    const res = await fetch(TEST_URL + '/audit-subrequest?method=' + method + query, {
        method: 'POST', body, headers: { Connection: 'close' }, signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    return res.json();
}

function provider(expectedMethod, expectedBody, status = 200) {
    mock.setDefault(async (req, url) => {
        const body = Buffer.from(await req.arrayBuffer());
        expect(req.method).toBe(expectedMethod);
        expect(body).toEqual(expectedBody);
        expect(Number(req.headers.get('content-length'))).toBe(expectedBody.length);
        expect(verifyProxyAuthorization(req.headers.get('authorization'), {
            method: req.method, path: url.pathname, query: url.search.slice(1), body,
            publicKey, mchId: '1900001111', serial: 'APICLIENTSERIAL123',
        })).toBe(true);
        return signedUpstreamResponse(responseBody, { privateKey, serial: 'PLATFORMSERIAL456', status });
    });
}

function checkAudit(reply, method, body, target = '/proxy-audit') {
    const raw = Buffer.from(reply.request, 'hex');
    expect(reply.audit).toBe(reply.request);
    const boundary = raw.indexOf('\r\n\r\n');
    expect(boundary).toBeGreaterThan(0);
    const headers = raw.subarray(0, boundary).toString();
    expect(headers.startsWith(method + ' ' + target + ' HTTP/1.1\r\n')).toBe(true);
    expect(headers).toContain('Content-Length: ' + body.length + '\r\n');
    expect(raw.subarray(boundary + 4)).toEqual(body);
}

async function healthy() {
    const res = await fetch(TEST_URL, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
}

function rawRequest(wire) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(8888, '127.0.0.1');
        let response = '';
        socket.setTimeout(3000, () => socket.destroy(new Error('raw request timed out')));
        socket.on('connect', () => socket.write(wire));
        socket.on('data', part => {
            response += part.toString();
            const boundary = response.indexOf('\r\n\r\n');
            if (boundary < 0) return;
            const length = response.slice(0, boundary).match(/\r\nContent-Length: (\d+)/i)?.[1];
            if (length !== undefined && response.length >= boundary + 4 + Number(length)) {
                socket.destroy();
                resolve(response);
            }
        });
        socket.on('end', () => resolve(response));
        socket.on('error', reject);
    });
}

describe('WeChat API v3 request auditing (QuickJS)', () => {
    beforeAll(async () => {
        mock = createHTTPMock(19001);
        await startNginz('tests/wechatpay/nginx.conf', 'wechatpay');
    });
    beforeEach(() => mock.reset());
    afterAll(async () => {
        try {
            await stopNginz();
            mock?.stop();
            const log = readFileSync('tests/wechatpay/runtime/logs/error.log', 'utf8');
            const failures = log.split('\n').filter(line => /\[alert\]|\[crit\]|header already sent|pending events while closing request|exited on signal|panic:|js unhandled rejection/.test(line));
            expect(failures).toEqual([]);
        } finally {
            cleanupRuntime('wechatpay');
        }
    });

    test.each(['GET', 'HEAD', 'POST', 'DELETE'])('audited empty %s succeeds directly and as a QuickJS subrequest', async (method) => {
        provider(method, Buffer.alloc(0));
        for (const headers of [{}, { 'Content-Length': '0' }]) {
            expect((await direct(method, undefined, headers)).status).toBe(200);
        }
        for (const query of ['', '&omit=1']) {
            const reply = await subrequest(method, undefined, query);
            expect(reply.status).toBe(200);
            checkAudit(reply, method, Buffer.alloc(0));
            if (method !== 'HEAD') {
                expect(reply.verification).toBe('success');
                expect(reply.body).toBe(responseBody);
            }
        }
        expect(mock.requestCount).toBe(4);
        await healthy();
    });

    test('audits a zero-length chunked POST', async () => {
        provider('POST', Buffer.alloc(0));
        const reply = await direct('POST', undefined, { 'Transfer-Encoding': 'chunked' });
        expect(reply.status).toBe(200);
        expect(reply.body).toBe(responseBody);
        expect(mock.requestCount).toBe(1);
    });

    // API v3 is an opaque signed proxy: malformed business payloads are audited
    // and sent exactly once; only the provider decides their business validity.
    test.each([
        ['whitespace', Buffer.from(' \t\r\n')],
        ['truncated JSON', Buffer.from('{"amount":')],
        ['duplicate JSON fields', Buffer.from('{"amount":1,"amount":2}')],
        ['embedded NUL', Buffer.from('{"x":"a\0b"}')],
        ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0xff, 0x22, 0x7d])],
        ['UTF-8 and unusual number spelling', Buffer.from(' {"中文":-0,"n":1e999} \n')],
    ])('preserves %s in signatures and the audit through provider rejection', async (_, body) => {
        provider('POST', body, 400);
        for (const headers of [{ 'Content-Length': String(body.length) }, { 'Transfer-Encoding': 'chunked' }]) {
            expect((await direct('POST', body, headers)).status).toBe(400);
        }
        const reply = await subrequest('POST', body);
        expect(reply.status).toBe(400);
        expect(reply.verification).toBe('success');
        expect(reply.body).toBe(responseBody);
        checkAudit(reply, 'POST', body);
        expect(mock.requestCount).toBe(3);
        await healthy();
    });

    test('a rejected empty audit prevents direct and QuickJS provider dispatch', async () => {
        provider('GET', Buffer.alloc(0));
        expect((await direct('GET', undefined, {}, '/proxy-audit?deny-audit=1')).status).toBe(503);
        const reply = await subrequest('GET', undefined, '&deny=1');
        expect(reply.status).toBe(503);
        checkAudit(reply, 'GET', Buffer.alloc(0), '/proxy-audit?deny-audit=1');
        expect(mock.requestCount).toBe(0);
        expect((await subrequest('GET')).status).toBe(200);
        expect(mock.requestCount).toBe(1);
    });

    test('signs the complete body after audited API v3 input spills to a file', async () => {
        const body = Buffer.from(JSON.stringify({text: '中文'.repeat(2000)}));
        provider('POST', body, 400);
        const reply = await direct('POST', body, { 'Content-Length': String(body.length) }, '/proxy-audit-spill');
        expect(reply.status).toBe(400);
        expect(reply.body).toBe(responseBody);
        expect(mock.requestCount).toBe(1);
    });

    test('bounds fixed-length, chunked and QuickJS bodies before audit or dispatch', async () => {
        const body = Buffer.alloc(65, 0xff);
        for (const headers of [{ 'Content-Length': '65' }, { 'Transfer-Encoding': 'chunked' }]) {
            expect((await direct('POST', body, headers, '/proxy-audit-bounded')).status).toBe(413);
        }
        const rejected = await subrequest('POST', body, '&bounded=1');
        expect(rejected.status).toBe(413);
        expect(rejected.request).toBe('');
        expect(rejected.response).toBe('');
        expect(rejected.audit).toBe('');
        expect(mock.requestCount).toBe(0);
        const boundary = Buffer.alloc(64, 0xff);
        provider('POST', boundary, 400);
        const accepted = await subrequest('POST', boundary, '&bounded=1');
        expect(accepted.status).toBe(400);
        checkAudit(accepted, 'POST', boundary, '/proxy-audit-bounded');
        expect(mock.requestCount).toBe(1);
    });

    test.each([
        ['negative length', 'Content-Length: -1\r\n', ''],
        ['nonnumeric length', 'Content-Length: invalid\r\n', ''],
        ['conflicting lengths', 'Content-Length: 0\r\nContent-Length: 1\r\n', 'x'],
        ['length and transfer encoding', 'Content-Length: 0\r\nTransfer-Encoding: chunked\r\n', '0\r\n\r\n'],
        ['invalid chunk size', 'Transfer-Encoding: chunked\r\n', 'G\r\nx\r\n0\r\n\r\n'],
    ])('rejects %s without provider dispatch and keeps serving', async (_, headers, body) => {
        const reply = await rawRequest('POST /proxy-audit HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' + headers + '\r\n' + body);
        expect(reply).toMatch(/^HTTP\/1\.1 400 /);
        expect(mock.requestCount).toBe(0);
        await healthy();
    });
});
