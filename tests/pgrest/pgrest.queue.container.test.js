// Public module regression: the locally built binary and the existing PostgreSQL
// test container. No application checkout, configuration or nginx image is used.
import { beforeAll, afterAll, afterEach, describe, test } from 'bun:test';
import { dockerCommand } from '../docker.js';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, constants } from 'node:http2';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const pg = 'pgrest-nginz-test';
const state = resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'nginz/tests/pgrest-queue');
const id = 'queue_' + randomBytes(6).toString('hex'), password = randomBytes(24).toString('hex');
const evidence = join(state, new Date().toISOString().replaceAll(/[^0-9]/g, '') + '-' + id);
const runtime = join(evidence, 'runtime');
const report = { status: 'running', checks: 0, scenarios: [] };
let nginz, databaseCreated = false, roleCreated = false, port, gateProcess;
const pending = new Map();
const soakSeconds = Number(process.env.PGREST_QUEUE_SOAK_SECONDS || 60);
const redact = s => String(s).replaceAll(password, '[redacted]');
const lit = s => "'" + String(s).replaceAll("'", "''") + "'";
function docker(args, input) {
    const [command, ...prefix] = dockerCommand();
    try { return execFileSync(command, [...prefix, ...args], { input, encoding: 'utf8', timeout: 30000, maxBuffer: 64e6, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch (e) { throw Error(redact(e.stderr || e.message)); }
}
const sqlArgs = db => ['exec', '-i', pg, 'psql', '-XqAt', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1'];
const sql = (text, db = id) => docker(sqlArgs(db), text);
const inspect = name => JSON.parse(docker(['inspect', name]))[0];
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); report.checks++; }
async function until(predicate, label, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await Bun.sleep(10); }
    throw Error('Timed out: ' + label);
}
function put(files) {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(runtime, name), data, { mode: 0o600 });
}
const logPath = runtime + '/' + id + '.log';
const logs = () => readFileSync(logPath, 'utf8');
const events = name => (logs().match(new RegExp('event=' + name + ' ', 'g')) || []).length;
function call(label, { route = 'api', gate = false, delay = 0, read = false } = {}) {
    const body = read ? undefined : JSON.stringify({ label, gate, delay });
    const path = route === 'njs' ? '/njs' : `/${route}/rpc/${read ? 'read?delay=' + delay : 'write'}`;
    let req, cancel, settled = false;
    const begin = performance.now();
    const promise = new Promise(done => {
        const deadline = setTimeout(() => { req.destroy(); finish({error:'HTTP deadline'}); },15000);
        const finish = result => { if (!settled) { settled = true; clearTimeout(deadline); pending.delete(req); done({ ...result, ms: performance.now() - begin }); } };
        cancel = () => { req.destroy(); finish({error:'intentional client cancellation'}); };
        req = request({ host: '127.0.0.1', port, path, method: read ? 'GET' : 'POST', agent: false, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', x => text += x);
            res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } finish({ status: res.statusCode, body: parsed }); });
            res.on('error', e => finish({ error: e.message }));
        });
        req.setTimeout(15000, () => req.destroy(Error('HTTP deadline')));
        req.on('error', e => finish({ error: e.message })); pending.set(req, cancel); req.end(body);
    });
    return { promise, cancel };
}
function h2Call(session, label) {
    const stream = session.request({':path':'/api/rpc/write',':method':'POST','content-type':'application/json'});
    let status, text='';
    const promise=new Promise((done,reject)=>{
        stream.on('response',headers=>status=headers[':status']);stream.setEncoding('utf8');
        stream.on('data',chunk=>text+=chunk);stream.on('error',reject);
        stream.on('end',()=>done({status,body:text}));
        stream.on('close',()=>done({status,body:text}));
    });
    stream.end(JSON.stringify({label}));
    return {promise,cancel(){stream.close(constants.NGHTTP2_CANCEL);}};
}
async function ok(handle, label) { const r = await handle.promise; check(r.status, 200, label + ': ' + JSON.stringify(r)); return r; }
function ledger(prefix) { return JSON.parse(sql(`SELECT coalesce(jsonb_agg(label ORDER BY seq),'[]') FROM queue.ledger WHERE label LIKE ${lit(prefix + '%')}`)); }
async function gate() {
    assert(!gateProcess);
    const [command, ...prefix] = dockerCommand();
    gateProcess = spawn(command, [...prefix, ...sqlArgs(id)], { stdio: ['pipe', 'ignore', 'pipe'] });
    gateProcess.stderr.resume();
    gateProcess.stdin.write("SET application_name='queue_gate'; SELECT pg_advisory_lock(913724);\n");
    await until(() => sql("SELECT count(*) FROM pg_stat_activity a WHERE datname=current_database() AND application_name='queue_gate' AND state='idle' AND EXISTS (SELECT FROM pg_locks l WHERE l.pid=a.pid AND locktype='advisory' AND granted)") === '1', 'gate acquired');
}
async function release() {
    if (!gateProcess) return;
    const proc = gateProcess; gateProcess = null;
    const exited = new Promise(done => proc.once('exit', done));
    // A live control connection avoids docker-exec startup latency in deadline
    // races. Unlock executes as soon as these bytes reach psql.
    proc.stdin.end("SELECT pg_advisory_unlock(913724);\n\\q\n");
    await exited;
}
async function blocked(label) {
    await gate(); const handle = call(label, { gate: true });
    await until(() => sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=${lit(id)} AND wait_event='advisory'`) === '1', 'active request owns slot');
    return handle;
}
async function queued(label, options = {}) {
    const before = events('queue-enter'), handle = call(label, options);
    await until(() => events('queue-enter') > before, label + ' entered queue');
    return handle;
}
function scenario(name, run, timeout = 20000) {
    test(name, async () => {
        const entry = { name, status: 'running' }, before = report.checks, start = Date.now(); report.scenarios.push(entry);
        try { await run(entry); entry.status = 'passed'; }
        catch (e) { entry.status = 'failed'; entry.error = redact(e.stack); throw e; }
        finally { entry.checks = report.checks - before; entry.ms = Date.now() - start; }
    }, timeout);
}
const dsn = `host=127.0.0.1 port=5432 dbname=${id} user=${id} password=${password}`;
function config(debug = true) {
    const routes = [['api',128,'5s'],['sibling',128,'5s'],['cap',2,'5s'],['off',0,'5s'],['zero',128,'0'],['race',128,'1s']].map(([route, size, timeout]) =>
        `location /${route}/ { rewrite ^/${route}/(.*)$ /$1 break; pgrest_pass "${dsn}"; pgrest_schemas queue; pgrest_pool_size 1; pgrest_pool_queue_size ${size}; pgrest_pool_acquisition_timeout ${timeout}; pgrest_json_scalar on; }`).join('\n');
    return `${process.getuid() === 0 ? 'user root;' : ''} worker_processes 1; pid ${runtime}/nginx.pid; error_log ${logPath} ${debug ? 'debug' : 'warn'};
    events { worker_connections 1024; } http { access_log off; js_engine qjs; js_import audit from ${runtime}/queue.mjs;
    client_body_temp_path ${runtime}/body; proxy_temp_path ${runtime}/proxy; fastcgi_temp_path ${runtime}/fastcgi; uwsgi_temp_path ${runtime}/uwsgi; scgi_temp_path ${runtime}/scgi;
    server { listen 127.0.0.1:${port}; http2 on; ${routes} location = /njs { js_content audit.call; } } }`;
}
function workers() { return readFileSync(`/proc/${nginz.pid}/task/${nginz.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); }
function sample() {
    const pids = workers(); check(pids.length, 1, 'one stable worker'); const pid = pids[0];
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)/m)[1]);
    const fd = readdirSync(`/proc/${pid}/fd`).length;
    const connections = Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=${lit(id)}`));
    return { pid, rssKiB, fd, connections };
}
describe('pgrest acquisition queue with real PostgreSQL', () => {
beforeAll(async () => {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    check(process.platform, 'linux', 'queue resource sampling requires Linux /proc');
    assert(Number.isFinite(soakSeconds) && soakSeconds >= 60 && soakSeconds <= 3600, 'PGREST_QUEUE_SOAK_SECONDS must be 60–3600');
    const database = inspect(pg); if (!database.State.Running) docker(['start',pg]);
    report.postgres_image = database.Image;
    const data = sql('SHOW data_directory', 'postgres'); check(database.Mounts.some(m => m.Type === 'volume' && (data === m.Destination || data.startsWith(m.Destination + '/'))), true, 'named database volume');
    // tests/preload.js builds this binary for the normal `bun test` command.
    const binaryPath = fileURLToPath(new URL('../../zig-out/bin/nginz', import.meta.url));
    report.candidate_sha256 = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
    const listener = createServer(); await new Promise(done => listener.listen(0,'127.0.0.1',done)); port = listener.address().port; await new Promise(done => listener.close(done));
    sql(`CREATE ROLE ${id} LOGIN PASSWORD ${lit(password)}`, 'postgres'); roleCreated = true;
    sql(`CREATE DATABASE ${id}`, 'postgres'); databaseCreated = true;
    sql(`CREATE SCHEMA queue AUTHORIZATION ${id}; SET ROLE ${id};
        CREATE TABLE queue.ledger(seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label text UNIQUE NOT NULL);
        CREATE FUNCTION queue.write(label text, gate boolean DEFAULT false, delay double precision DEFAULT 0) RETURNS text LANGUAGE plpgsql AS $$
        BEGIN IF gate THEN PERFORM pg_advisory_xact_lock(913724); END IF; PERFORM pg_sleep(delay); INSERT INTO queue.ledger(label) VALUES(write.label); RETURN label; END $$;
        CREATE FUNCTION queue.read(delay double precision DEFAULT 0) RETURNS integer STABLE LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(delay); RETURN 1; END $$;`);
    put({'nginx.conf':config(), 'queue.mjs':`async function call(r) { const reply = await r.subrequest('/api/rpc/write', {method:'POST',body:r.requestText}); r.return(reply.status,reply.responseText); } export default {call};\n`});
    nginz = spawn(binaryPath, ['-p', runtime, '-c', join(runtime,'nginx.conf'), '-g', 'daemon off;'], {stdio:['ignore','ignore','pipe']});
    nginz.stderr.on('data', bytes => appendFileSync(join(evidence,'stderr.log'), bytes, {mode:0o600}));
    let spawnError;
    nginz.on('error', error => {spawnError = error;});
    await until(async () => {
        if (spawnError) throw spawnError;
        if (nginz.exitCode !== null) throw Error('nginz exited during setup; see ' + join(evidence,'stderr.log'));
        return (await call('ready',{read:true}).promise).status === 200;
    }, 'nginz ready');
}, 30000);

afterEach(async () => {
    for (const cancel of pending.values()) cancel();
    await release();
}, 10000);

afterAll(async () => {
    const failures = [];
    // Attempt every cleanup independently, including when setup/tests failed.
    try {for (const cancel of pending.values()) cancel(); await release();} catch (e) {failures.push(e);}
    if (nginz) {
        try {
            if (nginz.exitCode === null && nginz.signalCode === null) {
                const exited = new Promise(done => nginz.once('exit', done));
                nginz.kill('SIGTERM');
                const deadline = setTimeout(() => nginz.kill('SIGKILL'), 5000);
                try {await exited;} finally {clearTimeout(deadline);}
            }
            const text = logs();
            check(/\[(?:alert|emerg)\]|signal 11|worker process .* exited on signal|request count is zero/i.test(text),false,'no crash or nginx lifetime alerts');
        } catch (e) {failures.push(e);}
    }
    try {if (databaseCreated) sql(`DROP DATABASE ${id} WITH (FORCE)`,'postgres');} catch (e) {failures.push(e);}
    try {if (roleCreated) sql(`DROP ROLE ${id}`,'postgres');} catch (e) {failures.push(e);}
    report.cleaned = failures.length === 0;
    report.status = report.cleaned && report.scenarios.length === 9 && report.scenarios.every(s => s.status === 'passed') ? 'passed' : 'failed';
    if (failures.length) report.cleanup_errors = failures.map(e => redact(e.stack));
    writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log('Queue audit '+report.status+': '+join(evidence,'report.json'));
    if (failures.length) throw new AggregateError(failures, 'Queue fixture cleanup failed');
}, 30000);

    scenario('queue cap, disabled queue and zero acquisition timeout reject before SQL', async () => {
        const active = await blocked('cap-active');
        const a = await queued('cap-a', {route:'cap'}), b = await queued('cap-b', {route:'cap'});
        for (const route of ['cap','off','zero']) {
            const result = await call('rejected-' + route, {route}).promise;
            check(result.status,504,route+' status'); check(result.body.code,'PGRST003',route+' code');
            check(result.body.message,'Timed out acquiring connection from connection pool.',route+' message');
        }
        check(ledger('rejected-'),[],'rejected writes never executed'); await release();
        await Promise.all([ok(active,'active'),ok(a,'cap a'),ok(b,'cap b')]);
        check(ledger('cap-'),['cap-active','cap-a','cap-b'],'cap preserves accepted writes');
    });
    scenario('strict FIFO across locations; newcomers cannot overtake', async () => {
        for (let iteration=0; iteration<5; iteration++) {
            const prefix = 'fifo-'+iteration+'-', active = await blocked(prefix+'active'), handles=[];
            for(let i=0;i<5;i++) handles.push(await queued(prefix+i,{route:i%2?'sibling':'api',delay:0.08}));
            await release();
            // Slow accepted work keeps a backlog alive when this newcomer
            // arrives after release, rather than testing an already empty queue.
            const newcomer=await queued(prefix+'new');
            await Promise.all([ok(active,'FIFO active'),...handles.map(h=>ok(h,'FIFO queued')),ok(newcomer,'FIFO newcomer')]);
            check(ledger(prefix),[prefix+'active',...Array.from({length:5},(_,i)=>prefix+i),prefix+'new'],'FIFO commit order');
        }
    });
    scenario('cancelled queued reads and writes free capacity before the slot is released', async () => {
        for (const route of ['api','njs']) {
            const prefix='cancel-'+route+'-', active=await blocked(prefix+'active');
            const before=events('queue-cancel');
            const write=await queued(prefix+'write',{route}), read=await queued(prefix+'read',{read:true});
            write.cancel(); read.cancel(); await Promise.all([write.promise,read.promise]);
            await until(()=>events('queue-cancel')>=before+2,'cancelled waiters removed before release',1000);
            const survivor=await queued(prefix+'survivor',{route:'cap'});
            await release(); await Promise.all([ok(active,'cancel active'),ok(survivor,'cancel survivor')]);
            check(ledger(prefix),[prefix+'active',prefix+'survivor'],'cancelled queued write never executed');
        }
    });
    scenario('HTTP/2 queued stream reset removes only that waiter', async () => {
        const active=await blocked('h2-active'), session=connect('http://127.0.0.1:'+port);
        try {
            const before=events('queue-enter'), cancelled=h2Call(session,'h2-cancel');
            await until(()=>events('queue-enter')>before,'HTTP/2 queued');
            const cancelBefore=events('queue-cancel');cancelled.cancel();await cancelled.promise;
            await until(()=>events('queue-cancel')>cancelBefore,'HTTP/2 cancelled',1000);
            const nextBefore=events('queue-enter'), survivor=h2Call(session,'h2-survivor');
            await until(()=>events('queue-enter')>nextBefore,'HTTP/2 survivor queued');
            await release();await Promise.all([ok(active,'HTTP/2 blocker'),ok(survivor,'HTTP/2 survivor')]);
            check(ledger('h2-'),['h2-active','h2-survivor'],'stream reset did not execute or cancel sibling');
        } finally {session.destroy();}
    });
    scenario('active client cancellation rolls back and releases the slot to waiters', async () => {
        const active=await blocked('active-cancel'), waiter=await queued('active-survivor');
        const before=events('request-cancel');active.cancel();await active.promise;
        await until(()=>events('request-cancel')>before,'active request cleanup',1000);
        await ok(waiter,'waiter runs while advisory gate remains held');await release();
        check(ledger('active-'),['active-survivor'],'cancelled active write rolled back');
    });
    scenario('slot release versus acquisition deadline; no duplicate execution or stale timers', async entry => {
        entry.outcomes={success:0,timeout:0};entry.attempts=[];
        for(let i=0;i<30;i++) {
            const prefix='race-'+i+'-', active=await blocked(prefix+'active');
            const before=events('queue-enter'), begin=Date.now(), waiter=call(prefix+'wait',{route:'race'});
            await until(()=>events('queue-enter')>before,'race queued');
            const offset=[-500,-40,-5,0,5,40,200][i%7];
            await Bun.sleep(Math.max(0,begin+1000+offset-Date.now()));
            const released=Date.now()-begin;await release();
            await ok(active,'race blocker'); const r=await waiter.promise;
            entry.attempts.push({release_ms:released,status:r.status,response_ms:r.ms});
            assert([200,504].includes(r.status),JSON.stringify(r)); report.checks++;
            if(r.status===200)entry.outcomes.success++;else {entry.outcomes.timeout++;check(r.body.code,'PGRST003','race timeout');}
            check(ledger(prefix),[prefix+'active',...(r.status===200?[prefix+'wait']:[])],'race database exactly matches response');
            await ok(call(prefix+'recovery'),'race recovery');
        }
        check(entry.outcomes.success>0,true,'both race outcomes: success');check(entry.outcomes.timeout>0,true,'both race outcomes: timeout');
        await Bun.sleep(1100); await ok(call('race-final',{read:true}),'no late callback failure');
    }, 90000);
    scenario('database backend loss with confirmed waiters; reconnect and rollback', async () => {
        const active=await blocked('db-active'), a=await queued('db-a'), b=await queued('db-b');
        sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${lit(id)}`);
        const failed=await active.promise; check(failed.status>=500&&failed.status<600,true,'database loss is bounded server error');
        await release(); await Promise.all([ok(a,'DB reconnect a'),ok(b,'DB reconnect b')]);
        check(ledger('db-'),['db-a','db-b'],'failed transaction rolled back; waiters commit once');
        await ok(call('db-recovery',{read:true}),'DB recovery');
    });
    scenario('graceful reload while old worker has a confirmed populated queue', async () => {
        const old=workers(), active=await blocked('reload-active'), handles=[];
        for(let i=0;i<6;i++)handles.push(await queued('reload-'+i,{route:i%2?'njs':'api'}));
        nginz.kill('SIGHUP');
        await until(()=>workers().some(pid=>!old.includes(pid)),'new worker spawned');
        check(workers().some(pid=>old.includes(pid)),true,'old worker retained queued requests');
        await release(); await Promise.all([ok(active,'reload active'),...handles.map(h=>ok(h,'reload waiter'))]);
        check(ledger('reload-'),['reload-active',...Array.from({length:6},(_,i)=>'reload-'+i)],'old queue drained FIFO exactly once');
        await until(()=>workers().every(pid=>!old.includes(pid)),'old worker exited',10000);
        await ok(call('reload-recovery',{read:true}),'new worker ready');
    });
    scenario('sustained saturation with bounded memory, descriptors and tail latency', async entry => {
        // No debug log I/O in measurements. Reload before warm-up, not during samples.
        const old=workers(); put({'nginx.conf':config(false)});
        nginz.kill('SIGHUP');
        await until(()=>workers().length===1&&workers()[0]!==old[0],'soak worker ready');
        const batch=async()=>Promise.all(Array.from({length:24},(_,i)=>call('soak',{read:true,delay:0.005,route:'api'}).promise));
        for(let i=0;i<8;i++){const rows=await batch();check(rows.every(r=>r.status===200),true,'warm-up');}
        entry.baseline=sample();entry.samples=[];const latencies=[];const begin=Date.now();let batches=0;
        const duration=soakSeconds*1000;
        assert(duration>=60000,'soak must run for at least 60 seconds');
        while(Date.now()-begin<duration){
            const rows=await batch();check(rows.every(r=>r.status===200),true,'soak no loss/deadline');latencies.push(...rows.map(r=>r.ms));batches++;
            if(batches%50===0){entry.samples.push(sample());console.log('Queue soak: '+latencies.length+' requests, '+Math.round((Date.now()-begin)/1000)+'s');}
        }
        await Bun.sleep(1000);entry.after=sample();entry.requests=latencies.length;entry.elapsed_ms=Date.now()-begin;
        latencies.sort((a,b)=>a-b);entry.latency_ms=Object.fromEntries([50,95,99,100].map(p=>['p'+p,latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p/100))]]));
        for(const s of [...entry.samples,entry.after]){check(s.pid,entry.baseline.pid,'worker stable');check(s.connections,1,'one DB slot');check(s.fd<=entry.baseline.fd+2,true,'bounded descriptors');check(s.rssKiB<=entry.baseline.rssKiB+16384,true,'RSS within 16MiB after warm-up');}
        check(entry.latency_ms.p99<2000,true,'p99 below 2s with 5s acquisition deadline');
        await ok(call('soak-recovery'),'post-soak write');
    }, (soakSeconds + 45) * 1000);
});
