import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { startNginz, stopNginz, cleanupRuntime, TEST_URL } from '../harness.js';

const MODULE = 'wechat-notify';
const APPID = 'wx0123456789abcdef';
const TOKEN = 'NotifyFixtureToken';
const KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const OTHER = { appid: 'wxfedcba9876543210', token: 'OtherFixtureToken', key: Buffer.alloc(32, 7) };
let runtime;
let upstream;
let proxyCalls = 0;

const signature = (...parts) => createHash('sha1').update(parts.sort().join('')).digest('hex');

function encrypt(body, { appid = APPID, key = KEY, badPadding = false, lengthOffset = 0 } = {}) {
    const message = Buffer.from(body);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length + lengthOffset);
    const raw = Buffer.concat([randomBytes(16), length, message, Buffer.from(appid)]);
    const padding = 32 - raw.length % 32;
    const padded = Buffer.concat([raw, Buffer.alloc(padding, padding)]);
    if (badPadding) padded[padded.length - 2] ^= 1;
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function fixture(body, options = {}) {
    const encrypted = options.encrypted ?? encrypt(body, options);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'fixture + nonce';
    const query = new URLSearchParams({ timestamp, nonce, encrypt_type: 'aes',
        msg_signature: signature(options.token ?? TOKEN, timestamp, nonce, encrypted) });
    const envelope = options.xml ? `<xml><ToUserName><![CDATA[receiver]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`
        : JSON.stringify({ Encrypt: encrypted });
    return { path: (options.path ?? '/echo') + '?' + query, body: envelope, encrypted };
}

async function push(body, options = {}) {
    const value = fixture(body, options);
    const reply = await fetch(TEST_URL + value.path, { method: 'POST', headers: {
        Connection: 'close', 'Content-Type': options.xml ? 'application/xml' : 'application/json' }, body: value.body });
    return { status: reply.status, text: await reply.text(), headers: reply.headers };
}

function request(value, { agent, chunked = false, split = false, expectContinue = false } = {}) {
    return new Promise((resolveRequest, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (chunked) headers['Transfer-Encoding'] = 'chunked';
        else headers['Content-Length'] = Buffer.byteLength(value.body);
        if (expectContinue) headers.Expect = '100-continue';
        const req = http.request({ host: '127.0.0.1', port: 8888, path: value.path, method: 'POST', agent, headers }, res => {
            const chunks = [];
            res.on('data', data => chunks.push(data));
            res.on('end', () => resolveRequest({ status: res.statusCode, text: Buffer.concat(chunks).toString(), reused: req.reusedSocket }));
        });
        req.on('error', reject);
        req.setTimeout(4000, () => req.destroy(new Error('native notification request timed out')));
        async function send() {
            if (split) {
                const midpoint = Math.floor(value.body.length / 2);
                req.write(value.body.slice(0, midpoint));
                await Bun.sleep(20);
                req.end(value.body.slice(midpoint));
            } else req.end(value.body);
        }
        if (expectContinue) { req.on('continue', send); req.flushHeaders(); }
        else send().catch(reject);
    });
}

describe('native WeChat message notifications', () => {
    beforeAll(async () => {
        upstream = Bun.serve({ hostname: '127.0.0.1', port: 19006, async fetch(req) {
            proxyCalls++;
            return Response.json({ body: await req.text(), length: req.headers.get('content-length'),
                type: req.headers.get('content-type'), transfer: req.headers.get('transfer-encoding') });
        } });
        runtime = await startNginz(`tests/${MODULE}/nginx.conf`, MODULE);
    });
    afterAll(async () => {
        await stopNginz();
        upstream?.stop(true);
        const log = readFileSync(join(runtime, 'logs/error.log'), 'utf8');
        expect(log).not.toMatch(/header already sent|\[alert\]|\[crit\]/);
        cleanupRuntime(MODULE);
    });

    test('verifies GET challenges and returns the decoded echostr', async () => {
        const timestamp = '1720000000', nonce = 'challenge', echostr = 'hello + 中文';
        const query = new URLSearchParams({ timestamp, nonce, echostr, signature: signature(TOKEN, timestamp, nonce) });
        const reply = await fetch(TEST_URL + '/success?' + query, { headers: { Connection: 'close' } });
        expect(reply.status).toBe(200);
        expect(reply.headers.get('content-type')).toBe('text/plain');
        expect(await reply.text()).toBe(echostr);
        query.set('signature', '0'.repeat(40));
        expect((await fetch(TEST_URL + '/success?' + query, { headers: { Connection: 'close' } })).status).toBe(403);
    });

    test('passes exact JSON plaintext and supports repeated provider deliveries', async () => {
        const body = ' { "Event":"xpay_goods_deliver_notify", "name":"阿明🏀" }\n';
        const value = fixture(body);
        for (let i = 0; i < 2; i++) {
            const reply = await request(value);
            expect([reply.status, reply.text]).toEqual([200, body]);
        }
    });

    test('passes XML plaintext from XML envelopes and CDATA', async () => {
        const body = '<xml><Event><![CDATA[wxa_media_check]]></Event><Text>中文 &amp; text</Text></xml>';
        const reply = await push(body, { xml: true });
        expect([reply.status, reply.text]).toEqual([200, body]);
    });

    test('njs reads plaintext with matching headers and native verification variables', async () => {
        const body = JSON.stringify({ Event: 'wxa_media_check', text: '中文🏀' });
        const reply = await push(body, { path: '/njs' });
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.text)).toEqual({ body, verifiedBody: body, verification: 'success', appid: APPID,
            contentType: 'application/json', contentLength: String(Buffer.byteLength(body)) });
        const xml = '<xml><Event>wxa_media_check</Event></xml>';
        expect(JSON.parse((await push(xml, { xml: true, path: '/njs' })).text).contentType).toBe('application/xml');
    });

    test('proxy receives only plaintext with corrected body framing', async () => {
        const body = '{"Event":"test"}';
        const reply = await request(fixture(body, { path: '/proxy' }), { chunked: true, split: true });
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.text)).toEqual({ body, length: String(Buffer.byteLength(body)), type: 'application/json', transfer: null });
    });

    test('handles delayed, chunked and Expect: 100-continue request bodies', async () => {
        const body = '{"Event":"split"}';
        for (const options of [{ split: true }, { split: true, chunked: true }, { expectContinue: true }]) {
            const reply = await request(fixture(body), options);
            expect([reply.status, reply.text]).toEqual([200, body]);
        }
    });

    test('handles file-backed encrypted request bodies', async () => {
        const body = JSON.stringify({ Event: 'test', text: '中文'.repeat(1800) });
        const reply = await push(body, { path: '/spill' });
        expect([reply.status, reply.text]).toEqual([200, body]);
    });

    test('supports every WeChat padding length', async () => {
        for (let length = 1; length <= 32; length++) {
            const body = JSON.stringify({ text: 'x'.repeat(length) });
            const reply = await push(body);
            expect([reply.status, reply.text]).toEqual([200, body]);
        }
    });

    test('rejects bad signatures, keys, AppIDs, padding and embedded lengths before proxy dispatch', async () => {
        const before = proxyCalls;
        for (const options of [{ token: OTHER.token }, { key: OTHER.key }, { appid: OTHER.appid }, { badPadding: true },
            { lengthOffset: 1 }, { lengthOffset: 10000 }, { encrypted: 'not-base64' }]) {
            expect((await push('{"Event":"test"}', { ...options, path: '/proxy' })).status).toBe(403);
        }
        expect(proxyCalls).toBe(before);
    });

    test('rejects malformed envelopes, duplicate fields and XML DTD/entity declarations', async () => {
        const value = fixture('{"Event":"test"}');
        for (const body of ['{}', '[]', value.body + 'junk', value.body.slice(0, -1) + ',"Encrypt":"other"}',
            `<xml><Encrypt>${value.encrypted}</Encrypt><Encrypt>${value.encrypted}</Encrypt></xml>`,
            `<!DOCTYPE xml [<!ENTITY cipher "${value.encrypted}">]><xml><Encrypt>&cipher;</Encrypt></xml>`,
            `<!DOCTYPE xml SYSTEM "file:///etc/passwd"><xml><Encrypt>${value.encrypted}</Encrypt></xml>`,
            `<xml><Encrypt><nested>${value.encrypted}</nested></Encrypt></xml>`]) {
            expect((await request({ ...value, body })).status).toBe(403);
        }
        expect((await request({ ...value, path: value.path + '&%6eonce=other' })).status).toBe(403);
        expect((await request({ ...value, path: value.path.replace('encrypt_type=aes', 'encrypt_type=raw') })).status).toBe(403);
    });

    test('bounds both fixed-length and chunked envelopes', async () => {
        const value = fixture(JSON.stringify({ text: 'x'.repeat(500) }), { path: '/bounded' });
        expect((await request(value)).status).toBe(413);
        expect((await request(value, { chunked: true, split: true })).status).toBe(413);
    });

    test('isolates app credentials and inherits enable/disable configuration', async () => {
        const body = '{"Event":"test"}';
        expect((await push(body, { path: '/other' })).status).toBe(403);
        expect((await push(body, { ...OTHER, path: '/other' })).text).toBe(body);
        expect((await push(body, { path: '/inherit/on' })).text).toBe(body);
        const off = await fetch(TEST_URL + '/inherit/off', { method: 'POST', body: 'unverified', headers: { Connection: 'close' } });
        expect([off.status, await off.text()]).toEqual([200, 'off']);
        expect(await (await fetch(TEST_URL + '/ordinary', { headers: { Connection: 'close' } })).text()).toBe('ordinary');
    });

    test('rejects unsupported methods and subrequest targets', async () => {
        expect((await fetch(TEST_URL + '/success', { method: 'PUT', headers: { Connection: 'close' } })).status).toBe(405);
        expect(await (await fetch(TEST_URL + '/subrequest', { headers: { Connection: 'close' } })).text()).toBe('403');
    });

    test('keeps request ownership balanced with synchronous echo content and reused sockets', async () => {
        const socket = net.createConnection({ host: '127.0.0.1', port: 8888 });
        let incoming = '';
        let pending;
        socket.setTimeout(4000, () => socket.destroy(new Error('keepalive request timed out')));
        socket.on('error', error => pending?.reject(error));
        socket.on('end', () => pending?.reject(new Error('keepalive connection ended early')));
        socket.on('data', data => {
            incoming += data.toString();
            const boundary = incoming.indexOf('\r\n\r\n');
            if (boundary < 0 || !pending) return;
            const header = incoming.slice(0, boundary);
            const raw = incoming.slice(boundary + 4);
            const length = header.match(/content-length:\s*(\d+)/i);
            let body = '';
            let consumed = 0;
            if (length) {
                consumed = Number(length[1]);
                if (raw.length < consumed) return;
                body = raw.slice(0, consumed);
            } else {
                while (true) {
                    const line = raw.indexOf('\r\n', consumed);
                    if (line < 0) return;
                    const size = parseInt(raw.slice(consumed, line), 16);
                    if (!Number.isFinite(size) || raw.length < line + 2 + size + 2) return;
                    consumed = line + 2;
                    if (size === 0) { consumed += 2; break; }
                    body += raw.slice(consumed, consumed + size);
                    consumed += size + 2;
                }
            }
            incoming = raw.slice(consumed);
            const current = pending;
            pending = null;
            current.resolve({ status: Number(header.split(' ')[1]), text: body });
        });
        await new Promise((ready, reject) => { socket.once('connect', ready); socket.once('error', reject); });
        try {
            for (let i = 0; i < 40; i++) {
                const value = fixture('{"Event":"test"}', { path: '/success' });
                const replyPromise = new Promise((resolveReply, reject) => { pending = { resolve: resolveReply, reject }; });
                const head = `POST ${value.path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(value.body)}\r\nConnection: keep-alive\r\n\r\n`;
                if (i % 2 === 0) {
                    socket.write(head + value.body.slice(0, 20));
                    await Bun.sleep(20);
                    socket.write(value.body.slice(20));
                } else socket.write(head + value.body);
                const reply = await replyPromise;
                expect([reply.status, reply.text]).toEqual([200, 'success']);
            }
        } finally { socket.destroy(); }
    });

    test('fails nginx configuration for missing/invalid credentials and incompatible access policies', () => {
        const fixtureDir = resolve('tests', MODULE);
        const base = readFileSync(join(fixtureDir, 'nginx.conf'), 'utf8').replaceAll('fixtures/', fixtureDir + '/fixtures/').replace('from content.js;', 'from "' + fixtureDir + '/content.js";');
        for (const [name, config, error] of [
            ['missing', base.replace(/wechat_notify_appid [^;]+;/, ''), 'invalid wechat_notify'],
            ['invalid-key', base.replace('wechat_notify_aes_key_file ' + fixtureDir + '/fixtures/aes-key;', 'wechat_notify_aes_key_file ' + fixtureDir + '/fixtures/token;'), 'invalid wechat_notify'],
            ['satisfy', base.replace('location = /echo {', 'location = /echo { satisfy any;'), 'requires satisfy all'],
            ['conflict', base.replace('location = /echo {', 'location = /echo { wechatpay_access;'), 'cannot be combined'],
        ]) {
            const path = join(runtime, name + '.conf');
            writeFileSync(path, config);
            const result = spawnSync(['./zig-out/bin/nginz', '-t', '-c', path, '-p', runtime], { stdout: 'pipe', stderr: 'pipe' });
            expect(result.stderr.toString()).toContain('test failed');
            expect(result.stderr.toString()).toContain(error);
        }
    });
});
