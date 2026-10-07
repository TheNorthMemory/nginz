// Native overflow regression, independent of all application repositories.
// Reuse the PostgreSQL fixture and named volume. Start an owned PostgREST
// container only from a local image, never pull/export/extract/install it.
import { beforeAll, afterAll, afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { connect, constants } from 'node:http2';
import { createServer, isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerCommand } from '../docker.js';
import {postgresFixture,pgContainer,adminArgs,explainSkip} from './container-fixture.js';
import {postgrestFixture,postgrestContainerArgs} from './postgrest-fixture.js';
import {createTempDir,cleanupTempDir} from './runtime.js';

const pg = pgContainer;
const id = 'spill_' + randomBytes(5).toString('hex');
const secret = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex');
const binary = fileURLToPath(new URL('../../zig-out/bin/nginz', import.meta.url));
const lit = x => "'" + String(x).replaceAll("'", "''") + "'";
let runtime, port, backendPort, downPort, nginz, nginzClosed, gateProcess, postgrestId, created = false, roleCreated = false;
const pending = new Set();
function docker(args, input, encoding = 'utf8') {
    const [command, ...prefix] = dockerCommand();
    return execFileSync(command, [...prefix, ...args], { input, encoding, timeout: 30000, maxBuffer: 64e6, stdio: ['pipe', 'pipe', 'pipe'] });
}
const sqlArgs = adminArgs;
const sql = (s, db = id) => docker(sqlArgs(db), s).trim();
async function prerequisites() {
    // Missing optional fixtures skip before any database/container is created.
    try { dockerCommand(); } catch { return {skip:'Docker is unavailable'}; }
    const database=await postgrestFixture(postgresFixture);if(database.skip)return database;
    return {...database,postgresPort:database.port,backupHost:database.backup.host,network:database.info.HostConfig.NetworkMode};
}
const fixture=await prerequisites();
explainSkip('spill',fixture);
const backupAuthority=()=>`${isIP(fixture.backupHost)===6?'['+fixture.backupHost+']':fixture.backupHost}:${backendPort}`;
const log = () => readFileSync(join(runtime, 'error.log'), 'utf8');
const events = name => (log().match(new RegExp('event=' + name + ' ', 'g')) || []).length;
async function until(f, label, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await f()) return; await Bun.sleep(5); }
    throw Error('Timeout: ' + label);
}
async function freePort() {
    const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
    const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
function token(owner = 'owner-a', key = secret) {
    const h = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const p = Buffer.from(JSON.stringify({ role: id, oid: owner, aud: 'spill', exp: Math.floor(Date.now()/1000)+600 })).toString('base64url');
    return h + '.' + p + '.' + createHmac('sha256', key).update(h + '.' + p).digest('base64url');
}
function call(path = '/api/rpc/read', { method = 'GET', body, raw, bearer = token(), headers = {}, hostname='127.0.0.1', httpPort=port } = {}) {
    const bytes = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    let req, finish; const start = performance.now();
    const promise = new Promise(done => {
        let settled = false;
        finish = result => { if (!settled) { settled = true; pending.delete(req); done({ ...result, ms: performance.now()-start }); } };
        req = request({ host: hostname, port: httpPort, path, method, agent: false, headers: {
            authorization: 'Bearer ' + bearer, ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }), ...headers,
        } }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', x => text += x);
            res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } finish({ status: res.statusCode, data, headers: res.headers }); });
            res.on('error', e => finish({ error: e.message }));
        });
        req.on('error', e => finish({ error: e.message }));
        req.setTimeout(12000, () => req.destroy(Error('HTTP deadline')));
        pending.add(req); req.end(bytes);
    });
    return { promise, cancel() { req.destroy(); finish({error:'intentional cancellation'}); } };
}
async function ok(h, backend) {
    const r = await h.promise; assert.equal(r.status, 200, JSON.stringify(r));
    if (backend) assert.equal(r.headers['x-spill-backend'], backend); return r;
}
const write = (label, options = {}) => call('/api/rpc/write', { method:'POST', body:{label}, ...options });
const count = label => Number(sql(`SELECT count(*) FROM spill.ledger WHERE label=${lit(label)}`));
async function gate() {
    assert(!gateProcess);
    const [command, ...prefix] = dockerCommand();
    gateProcess = spawn(command, [...prefix, ...sqlArgs(id)], { stdio: ['pipe','ignore','pipe'] }); gateProcess.stderr.resume();
    gateProcess.stdin.write("SET application_name='spill_gate'; SELECT pg_advisory_lock(792415);\n");
    await until(() => sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='spill_gate' AND state='idle'") === '1', 'gate');
}
async function release() {
    if (!gateProcess) return;
    const p = gateProcess; gateProcess = null; const exit = new Promise(r => p.once('exit', r));
    p.stdin.end('SELECT pg_advisory_unlock(792415);\n\\q\n'); await exit;
}
async function blocked(label) {
    await gate(); const h = call('/blocker/rpc/write', { method:'POST', body:{label,gate:true} });
    await until(() => sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='spill_native' AND wait_event='advisory'") === '1', 'native occupies slot');
    return h;
}
async function queued(path, options) {
    const n = events('queue-enter'), h = call(path, options);
    await until(() => events('queue-enter') > n, 'waiter admitted'); return h;
}
const guard = () => `jwt_secret "${secret}"; jwt_audience spill; jwt_require_claim role eq ${id}; jwt_require_claim oid !eq ""; jwt_validate_exp on; jwt_validate_sig on; jwt_phase preaccess;`;
const native = () => `pgrest_pass "host=${fixture.host} port=${fixture.postgresPort} dbname=${id} user=${id} password=${password} application_name=spill_native"; pgrest_schemas spill; pgrest_pool_size 1; pgrest_jwt_secret "${secret}"; pgrest_json_scalar on;`;
function config() {
    // The blocker shares the native pool, with time for Docker probes and the
    // backup's acquisition timeout before the test explicitly releases its lock.
    const locations = [ ['blocker',0,'0','off','10s'], ['api',8,'200ms','@backup','2s'], ['off',8,'60ms','off','2s'], ['full',0,'200ms','@backup','2s'], ['zero',8,'0','@backup','2s'], ['missing',8,'50ms','@missing','2s'], ['loop',8,'50ms','@loop','2s'], ['down',8,'50ms','@down','2s'], ['timeout',8,'200ms','@backup','60ms'], ['race',8,'60ms','@backup','2s'] ].map(([name, cap, delay, fallback, timeout]) =>
        `location /${name}/ { ${guard()} rewrite ^/${name}/(.*)$ /$1 break; ${native()} pgrest_timeout ${timeout}; pgrest_pool_acquisition_timeout ${delay}; pgrest_pool_queue_size ${cap}; pgrest_pool_fallback ${fallback}; add_header X-Spill-Backend native always; }`).join('\n');
    return `${process.getuid()===0?'user root;':''} worker_processes 1; pid ${runtime}/nginx.pid; error_log ${runtime}/error.log debug;
    events { worker_connections 1024; } http { access_log off; client_max_body_size 64k; client_body_buffer_size 1k;
    js_engine qjs; js_import fixture from ${runtime}/subrequest.mjs;
    client_body_temp_path ${runtime}/body; proxy_temp_path ${runtime}/proxy; fastcgi_temp_path ${runtime}/fastcgi; uwsgi_temp_path ${runtime}/uwsgi; scgi_temp_path ${runtime}/scgi;
    server { listen 127.0.0.1:${port}; http2 on; ${locations}
    location @backup { ${guard()} proxy_pass http://${backupAuthority()}; proxy_next_upstream off; proxy_intercept_errors off; proxy_read_timeout 4s; add_header X-Spill-Backend postgrest always; }
    location @down { proxy_pass http://127.0.0.1:${downPort}; proxy_next_upstream off; add_header X-Spill-Backend down always; }
    location @loop { ${native()} pgrest_pool_fallback @backup; }
    location = /njs { js_content fixture.call; }
    location = /ssi { ssi on; ssi_types *; default_type text/html; echozn "before<!--# include virtual='/api/rpc/read' -->after"; }
    location = /auth { auth_request /api/rpc/read; echozn "authorized"; }
    } }`;
}
describe.skipIf(Boolean(fixture.skip))('native delayed spill to PostgREST 16.4', () => {
beforeAll(async () => {
    runtime=createTempDir('spill');
    [port, backendPort, downPort] = await Promise.all([freePort(),freePort(),freePort()]);
    sql(`CREATE ROLE ${id} LOGIN PASSWORD ${lit(password)}`,'postgres'); roleCreated = true;
    sql(`CREATE DATABASE ${id}`,'postgres'); created = true;
    sql(`CREATE SCHEMA spill AUTHORIZATION ${id}; SET ROLE ${id};
    CREATE TABLE spill.ledger(seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label text NOT NULL);
    CREATE FUNCTION spill.read(value text DEFAULT '',delay double precision DEFAULT 0) RETURNS jsonb STABLE LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(delay); RETURN jsonb_build_object('value',value,'owner',current_setting('request.jwt.claims',true)::jsonb->>'oid','method',current_setting('request.method',true),'header',current_setting('request.headers',true)::jsonb->>'x-test'); END $$;
    CREATE FUNCTION spill.write(label text,gate boolean DEFAULT false,delay double precision DEFAULT 0,bad boolean DEFAULT false) RETURNS text LANGUAGE plpgsql AS $$ BEGIN IF gate THEN PERFORM pg_advisory_xact_lock(792415); END IF; PERFORM pg_sleep(delay); INSERT INTO spill.ledger(label) VALUES(write.label); IF bad THEN PERFORM set_config('response.status','invalid',true); END IF; RETURN label; END $$;
    CREATE FUNCTION spill.fail(code text) RETURNS text STABLE LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE=code,MESSAGE='fixture error'; END $$;`);
    postgrestId=docker(postgrestContainerArgs(fixture,{name:id+'-postgrest',database:id,password,secret,port:backendPort})).trim();
    docker(['start',postgrestId]);
    assert.equal(docker(['exec',postgrestId,'/bin/postgrest','--version']).trim(),'PostgREST 16.4');
    if(fixture.backup.publish){
        const info=JSON.parse(docker(['inspect',postgrestId]))[0];
        backendPort=Number(info.NetworkSettings.Ports['3000/tcp'][0].HostPort);
        assert(Number.isInteger(backendPort)&&backendPort>0,'published PostgREST port');
    }
    writeFileSync(join(runtime,'nginx.conf'),config(),{mode:0o600});
    writeFileSync(join(runtime,'subrequest.mjs'),`async function call(r) { const s=await r.subrequest('/api/rpc/write',{method:'POST',body:r.requestText}); r.return(s.status,s.responseText); } export default {call};`,{mode:0o600});
    nginz = spawn(binary,['-p',runtime,'-c',join(runtime,'nginx.conf'),'-g','daemon off;'],{stdio:['ignore','ignore','pipe']});
    nginzClosed=new Promise(done=>nginz.once('close',done));
    nginz.stderr.on('data',b=>appendFileSync(join(runtime,'stderr.log'),b,{mode:0o600}));
    await until(async()=>{if(nginz.exitCode!==null)throw Error(readFileSync(join(runtime,'stderr.log'),'utf8'));return (await call().promise).status===200;},'native ready');
    await until(async()=>(await call('/rpc/read',{hostname:fixture.backupHost,httpPort:backendPort}).promise).status===200,'PostgREST ready');
},30000);
afterEach(async()=>{for(const r of pending)r.destroy(Error('test cleanup'));await release();},10000);
afterAll(async()=>{
    const failures=[];
    try {for(const r of pending)r.destroy();await release();}catch(e){failures.push(e);}
    try {
        if(nginz?.pid && nginz.exitCode===null && nginz.signalCode===null){
            nginz.kill('SIGTERM');
            const deadline=setTimeout(()=>nginz.kill('SIGKILL'),5000);
            try {await nginzClosed;}finally {clearTimeout(deadline);}
        }
        await nginzClosed;
    }catch(e){failures.push(e);}
    try {if(postgrestId)docker(['rm','-f',postgrestId]);}catch(e){failures.push(e);}
    try {if(created)sql(`DROP DATABASE ${id} WITH (FORCE)`,'postgres');}catch(e){failures.push(e);}
    try {if(roleCreated)sql(`DROP ROLE ${id}`,'postgres');}catch(e){failures.push(e);}
    try {if(runtime && existsSync(join(runtime,'error.log')))assert(!/\[(alert|emerg)\]|worker process .* exited on signal|request count is zero/.test(log()),'no nginx lifetime alerts');}catch(e){failures.push(e);}
    try {cleanupTempDir(runtime);}catch(e){failures.push(e);}
    if(failures.length)throw new AggregateError(failures,'spill cleanup');
},20000);
test('free slots and slots released during the delay stay native',async()=>{
    await ok(call(),'native');const active=await blocked('short-active');
    const waiter=await queued('/api/rpc/write',{method:'POST',body:{label:'short-waiter'}});
    await release();await Promise.all([ok(active,'native'),ok(waiter,'native')]);assert.equal(count('short-waiter'),1);
},20000);
test('delayed GET, HEAD and disk-buffered POST preserve identity, URI, headers and body',async()=>{
    const active=await blocked('preserve-active');
    const r=await ok(call('/api/rpc/read?value=a%2Bb%20%26%3F',{bearer:token('owner-b'),headers:{'x-test':'retained'}}),'postgrest');
    assert(r.ms>=170,'waited for acquisition deadline');assert.deepEqual(r.data,{value:'a+b &?',owner:'owner-b',method:'GET',header:'retained'});
    const h=await ok(call('/api/rpc/read',{method:'HEAD'}),'postgrest');assert.equal(h.data,'');
    const label='large-'+ 'x'.repeat(10000);const w=await ok(write(label),'postgrest');assert.equal(w.data,label);assert.equal(count(label),1);
    await release();await ok(active,'native');await Bun.sleep(250);assert.equal(count(label),1,'native never replays spilled write');
},20000);
test('PATCH and DELETE retain their method, filters and Prefer header',async()=>{
    sql("INSERT INTO spill.ledger(label) VALUES('patch-me'),('keep-me')");const active=await blocked('methods-active');
    const r=await ok(call('/api/ledger?label=eq.patch-me',{method:'PATCH',body:{label:'patched'},headers:{Prefer:'return=representation'}}),'postgrest');
    assert.equal(r.data.length,1);assert.equal(r.data[0].label,'patched');
    await ok(call('/api/ledger?label=eq.patched',{method:'DELETE',headers:{Prefer:'return=representation'}}),'postgrest');
    assert.equal(count('patched'),0);assert.equal(count('keep-me'),1);await release();await ok(active);
},20000);
test('disabled fallback rejects, queue full and zero delay spill immediately',async()=>{
    const active=await blocked('limits-active');
    const off=await call('/off/rpc/read').promise;assert.equal(off.status,504);assert.equal(off.data.code,'PGRST003');assert.equal(off.headers['x-spill-backend'],'native');
    for(const route of ['full','zero'])await ok(call('/'+route+'/rpc/read'),'postgrest');
    await release();await ok(active);
},20000);
test('authentication failures, SQL failures and post-commit response failures never spill',async()=>{
    const before=events('pool-spill');const active=await blocked('auth-active');
    assert.equal((await call('/api/rpc/read',{bearer:token('owner-a','wrong')}).promise).status,401);
    await release();await ok(active);
    for(const code of ['PT500','PT503','PT504'])assert.equal((await call('/api/rpc/fail?code='+code).promise).status,Number(code.slice(2)));
    const bad=await write('committed-once',{body:{label:'committed-once',bad:true}}).promise;
    assert.equal(bad.status,500);assert.equal(count('committed-once'),1);
    const timeout=await call('/timeout/rpc/write',{method:'POST',body:{label:'timed-out',delay:0.3}}).promise;
    assert.equal(timeout.status,504);await Bun.sleep(350);assert.equal(count('timed-out'),0);
    assert.equal(events('pool-spill'),before);
},20000);
test('missing target, reentry and unavailable PostgREST fail once without SQL replay',async()=>{
    const active=await blocked('errors-active');
    for(const [route,status] of [['missing',500],['loop',504],['down',502]]){
        const n=events('pool-spill'),r=await call('/'+route+'/rpc/write',{method:'POST',body:{label:route}}).promise;
        assert.equal(r.status,status,JSON.stringify(r));assert.equal(events('pool-spill'),n+1);assert.equal(count(route),0);
    }
    await release();await ok(active);
},20000);
test('PostgREST acquisition timeout is returned with no retry',async()=>{
    const active=await blocked('backup-full-active');
    // Hold the backup slot until its acquisition error arrives, independent of
    // Docker polling latency. Both occupants wait on the same advisory lock.
    const busy=call('/full/rpc/write',{method:'POST',body:{label:'backup-full-busy',gate:true}});
    await until(()=>sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='spill_backup' AND wait_event='advisory'")==='1','backup occupied');
    const n=events('pool-spill');
    const r=await call('/full/rpc/write',{method:'POST',body:{label:'backup-rejected'}}).promise;
    assert.equal(r.status,504,JSON.stringify(r));assert.equal(r.data.code,'PGRST003');assert.equal(r.headers['x-spill-backend'],'postgrest');assert.equal(count('backup-rejected'),0);
    await release();await Promise.all([ok(busy,'postgrest'),ok(active,'native')]);
    assert.equal(events('pool-spill'),n+1,'rejected request spills once');
    assert.equal(count('backup-full-busy'),1);assert.equal(count('backup-rejected'),0,'rejected write never executes after release');
},20000);
test('njs, SSI and auth subrequests complete through native named-location handoff',async()=>{
    const active=await blocked('subrequests-active');
    const r=await ok(call('/njs',{method:'POST',body:{label:'subrequest'}}));assert.equal(r.data,'subrequest');assert.equal(count('subrequest'),1);
    const s=await ok(call('/ssi'));assert.match(s.data,/^before.*after$/);
    const a=await ok(call('/auth'));assert.equal(a.data,'authorized');
    await release();await ok(active);
},20000);
test('client cancellation before expiry cannot spill or execute later',async()=>{
    const active=await blocked('cancel-active'), n=events('pool-spill'),cancelled=await queued('/api/rpc/write',{method:'POST',body:{label:'cancelled'}});
    const c=events('queue-cancel');cancelled.cancel();await cancelled.promise;await until(()=>events('queue-cancel')>c,'cancel unlinked');
    await Bun.sleep(250);assert.equal(events('pool-spill'),n);assert.equal(count('cancelled'),0);await release();await ok(active);
},20000);
test('HTTP/2 reset cancels only its waiter while a sibling spills',async()=>{
    const active=await blocked('h2-active'),session=connect('http://127.0.0.1:'+port);
    try{
        const send=label=>{const s=session.request({':path':'/api/rpc/write',':method':'POST','content-type':'application/json',authorization:'Bearer '+token()});let status,body='';const promise=new Promise(done=>{s.on('response',h=>status=h[':status']);s.on('data',b=>body+=b);s.on('error',()=>{});s.on('close',()=>done({status,body}));});s.end(JSON.stringify({label}));return{s,promise};};
        const before=events('queue-enter'),cancel=send('h2-cancel');await until(()=>events('queue-enter')>before,'h2 waiter');cancel.s.close(constants.NGHTTP2_CANCEL);await cancel.promise;
        const survivor=send('h2-survivor'),r=await survivor.promise;assert.equal(r.status,200);assert.equal(count('h2-cancel'),0);assert.equal(count('h2-survivor'),1);
    }finally{session.destroy();await release();await ok(active);}
},20000);
test('release versus spill deadline races execute each write exactly once',async()=>{
    for(let i=0;i<20;i++){
        const active=await blocked('race-active-'+i),h=await queued('/race/rpc/write',{method:'POST',body:{label:'race-'+i}});
        await Bun.sleep(i%2?55:5);await release();await Promise.all([ok(active),ok(h)]);assert.equal(count('race-'+i),1);
    }
},60000);
test('graceful reload drains a pending spill and accepts the new worker',async()=>{
    const active=await blocked('reload-active'),h=await queued('/api/rpc/write',{method:'POST',body:{label:'reload-spill'}});
    nginz.kill('SIGHUP');await ok(h,'postgrest');await release();await ok(active);assert.equal(count('reload-spill'),1);await ok(call(),'native');
},20000);
});
