// Subrequest semantics against PostgreSQL, independent of application repos.
// Reuse only the optional selected test container and its named data volume.
import { beforeAll, afterAll, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresFixture, adminArgs, docker, explainSkip } from './container-fixture.js';
import { createTempDir, cleanupTempDir } from './runtime.js';

const fixture = await postgresFixture();
explainSkip('subrequest', fixture);
const id = 'subreq_' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const binary = fileURLToPath(new URL('../../zig-out/bin/nginz', import.meta.url));
const lit = x => "'" + String(x).replaceAll("'", "''") + "'";
const sql = (text, database = id) => docker(adminArgs(database), text).trim();
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const pending = new Set();
let runtime, port, nginz, nginzClosed, roleCreated = false, databaseCreated = false;

function call(path, { method = 'GET', body, headers = {}, keepAlive = false } = {}) {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((done, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, agent: keepAlive ? agent : false,
            headers: { ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }), ...headers },
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => text += chunk);
            res.on('end', () => {
                pending.delete(req);
                let data;
                try { data = JSON.parse(text); } catch { data = text; }
                done({ status: res.statusCode, headers: res.headers, data });
            });
            res.on('error', error => { pending.delete(req); reject(error); });
        });
        pending.add(req);
        req.setTimeout(5000, () => req.destroy(Error('subrequest HTTP deadline')));
        req.on('error', error => { pending.delete(req); reject(error); });
        req.end(bytes);
    });
}

async function until(check, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(20);
    }
    throw Error('Timed out: ' + label);
}

describe.skipIf(Boolean(fixture.skip))('pgrest subrequests with real PostgreSQL', () => {
    beforeAll(async () => {
        runtime = createTempDir('subrequest');
        const listener = createServer();
        await new Promise(done => listener.listen(0, '127.0.0.1', done));
        port = listener.address().port;
        await new Promise(done => listener.close(done));
        sql(`CREATE ROLE ${id} LOGIN PASSWORD ${lit(password)}`, 'postgres');
        roleCreated = true;
        sql(`CREATE DATABASE ${id}`, 'postgres');
        databaseCreated = true;
        sql(`CREATE SCHEMA fixture AUTHORIZATION ${id}; SET ROLE ${id};
            CREATE TABLE fixture.items(label text PRIMARY KEY, value integer NOT NULL);
            CREATE TABLE fixture.ledger(label text NOT NULL);
            CREATE FUNCTION fixture.add_them(a integer,b integer) RETURNS integer IMMUTABLE LANGUAGE sql AS $$ SELECT a+b $$;
            CREATE FUNCTION fixture.authorize() RETURNS integer STABLE LANGUAGE sql AS $$ SELECT 1 $$;
            CREATE FUNCTION fixture.context(value text,delay double precision DEFAULT 0) RETURNS jsonb STABLE LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(delay); RETURN jsonb_build_object('value',value,'method',current_setting('request.method',true),
                'path',current_setting('request.path',true),'header',current_setting('request.headers',true)::jsonb->>'x-test'); END $$;
            CREATE FUNCTION fixture.write(label text,bad boolean DEFAULT false,delay double precision DEFAULT 0) RETURNS text LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(delay); INSERT INTO fixture.ledger VALUES(write.label);
                IF bad THEN PERFORM set_config('response.headers','invalid',true); END IF;
                RETURN label; END $$;
            CREATE FUNCTION fixture.fail() RETURNS integer STABLE LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='subrequest fixture error'; END $$;`);
        const dsn = `host=${fixture.host} port=${fixture.port} dbname=${id} user=${id} password=${password}`;
        writeFileSync(join(runtime, 'nginx.conf'), `${process.getuid?.() === 0 ? 'user root;' : ''}
            worker_processes 1; pid ${runtime}/nginx.pid; error_log ${runtime}/error.log debug;
            events { worker_connections 128; } http { access_log off;
            js_engine qjs; js_import fixture from ${fileURLToPath(new URL('./subrequest-fixture.mjs', import.meta.url))};
            client_body_temp_path ${runtime}/body; proxy_temp_path ${runtime}/proxy;
            fastcgi_temp_path ${runtime}/fastcgi; uwsgi_temp_path ${runtime}/uwsgi; scgi_temp_path ${runtime}/scgi;
            server { listen 127.0.0.1:${port};
                location /db/ { rewrite ^/db/(.*)$ /$1 break; pgrest_pass "${dsn}"; pgrest_schemas fixture;
                    pgrest_pool_size 2; pgrest_pool_queue_size 16; pgrest_pool_acquisition_timeout 3s; }
                location = /njs/mixed { js_content fixture.mixed; }
                location = /njs/siblings { js_content fixture.siblings; }
                location = /njs/recover { js_content fixture.recover; }
                location = /njs/head { js_content fixture.head; }
                location = /njs/detached { js_content fixture.detached; }
                location = /ssi { ssi on; ssi_types *; default_type text/html;
                    echozn "before<!--# include virtual='/db/rpc/add_them?a=10&b=20' -->after"; }
                location = /auth { auth_request /db/rpc/authorize; echozn "authorized"; }
                location = /mirror { mirror /db/rpc/write; mirror_request_body on; echozn "mirrored"; }
            } }`, { mode: 0o600 });
        nginz = spawn(binary, ['-p', runtime, '-c', join(runtime, 'nginx.conf'), '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
        nginzClosed = new Promise(done => nginz.once('close', done));
        let spawnError;
        nginz.on('error', error => { spawnError = error; });
        nginz.stderr.on('data', bytes => appendFileSync(join(runtime, 'stderr.log'), bytes, { mode: 0o600 }));
        await until(async () => {
            if (spawnError) throw spawnError;
            if (nginz.exitCode !== null) throw Error('nginz exited during setup: ' + readFileSync(join(runtime, 'stderr.log'), 'utf8'));
            try { return (await call('/db/rpc/add_them?a=1&b=2')).status === 200; }
            catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return false; }
        }, 'nginz ready');
    }, 30000);

    afterAll(async () => {
        const errors = [];
        try { for (const req of pending) req.destroy(); agent.destroy(); } catch (error) { errors.push(error); }
        try {
            if (nginz?.pid && nginz.exitCode === null && nginz.signalCode === null) {
                nginz.kill('SIGTERM');
                const deadline = setTimeout(() => nginz.kill('SIGKILL'), 5000);
                try { await nginzClosed; } finally { clearTimeout(deadline); }
            }
            await nginzClosed;
        } catch (error) { errors.push(error); }
        try { if (databaseCreated) sql(`DROP DATABASE ${id} WITH (FORCE)`, 'postgres'); } catch (error) { errors.push(error); }
        try { if (roleCreated) sql(`DROP ROLE ${id}`, 'postgres'); } catch (error) { errors.push(error); }
        try {
            if (runtime) {
                const path = join(runtime, 'error.log');
                if (existsSync(path)) assert(!/\[(alert|emerg)\]|worker process .* exited on signal|request count is zero|header already sent/.test(readFileSync(path, 'utf8')), 'no nginx lifetime or header alerts');
            }
        } catch (error) { errors.push(error); }
        try { cleanupTempDir(runtime); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Subrequest cleanup/lifetime checks failed');
    }, 30000);

    test('mixed CRUD and RPC in one parent, repeated on one keep-alive connection', async () => {
        for (let i = 0; i < 10; i++) {
            const label = 'mixed-' + i;
            const r = await call('/njs/mixed?label=' + label, { method: 'POST', body: { label: 'parent-body' },
                headers: { prefer: 'return=representation' }, keepAlive: true });
            assert.equal(r.status, 200);
            assert.deepEqual(r.data, [
                { status: 201, body: [{ label, value: 1 }] },
                { status: 200, body: [{ label, value: 2 }] },
                { status: 200, body: 3 },
                { status: 200, body: [{ label, value: 2 }] },
                { status: 200, body: [{ label, value: 2 }] },
                { status: 200, body: [] },
            ]);
        }
        assert.equal(sql('SELECT count(*) FROM fixture.items'), '0');
    }, 15000);

    test('parallel sibling subrequests isolate SQL arguments and request context', async () => {
        const r = await call('/njs/siblings', { method: 'POST', body: { value: 'parent-body' }, headers: { 'x-test': 'siblings' } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.data, Array.from({ length: 8 }, (_, i) => ({ status: 200,
            body: { value: String(i), method: 'GET', path: '/rpc/context', header: 'siblings' } })));
    });

    test('SQL errors and invalid response headers complete without poisoning the next sibling', async () => {
        const r = await call('/njs/recover', { method: 'POST', body: {}, headers: { 'content-type': 'application/json' } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.data.map(x => x.status), [409, 200, 500, 200]);
        assert.equal(r.data[0].body.code, '23505');
        assert.equal(r.data[1].body, 3);
        assert.equal(r.data[2].body.code, 'PGRST111');
        assert.equal(r.data[3].body, 3);
        assert.equal(sql("SELECT count(*) FROM fixture.ledger WHERE label='invalid-header'"), '1', 'response error occurs after commit; never replay the write');
    });

    test('HEAD subrequest completes with no captured body', async () => {
        for (const [fn, status] of [['add_them', 200], ['fail', 409], ['missing', 404]]) {
            const r = await call('/njs/head?fn=' + fn);
            assert.equal(r.status, 200);
            assert.deepEqual(r.data, { status, body: '' });
        }
    });

    test('SSI includes only the subrequest body and auth discards it', async () => {
        const ssi = await call('/ssi');
        assert.equal(ssi.status, 200);
        assert.equal(ssi.data, 'before30after');
        const auth = await call('/auth');
        assert.equal(auth.status, 200);
        assert.equal(auth.data, 'authorized');
    });

    test('background mirror executes its database request exactly once', async () => {
        for (const keepAlive of [false, true]) {
            const label = 'mirror-' + keepAlive;
            const r = await call('/mirror', { method: 'POST', body: { label, delay: 0.05 }, keepAlive });
            assert.equal(r.status, 200);
            assert.equal(r.data, 'mirrored');
            await until(() => sql(`SELECT count(*) FROM fixture.ledger WHERE label=${lit(label)}`) === '1', 'mirror write committed');
            assert.equal(sql(`SELECT count(*) FROM fixture.ledger WHERE label=${lit(label)}`), '1');
        }
        assert.equal((await call('/db/rpc/add_them?a=1&b=2')).data, 3);
    }, 10000);

    test('detached njs writes finish after the parent response, including committed response errors', async () => {
        for (const bad of [false, true]) {
            const label = 'detached-' + bad;
            const r = await call('/njs/detached', { method: 'POST', body: { label, bad, delay: 0.05 } });
            assert.equal(r.status, 202);
            assert.equal(r.data, 'accepted');
            await until(() => sql(`SELECT count(*) FROM fixture.ledger WHERE label=${lit(label)}`) === '1', 'detached write committed');
            assert.equal(sql(`SELECT count(*) FROM fixture.ledger WHERE label=${lit(label)}`), '1');
            assert.equal((await call('/db/rpc/add_them?a=1&b=2')).data, 3);
        }
    }, 10000);
});
