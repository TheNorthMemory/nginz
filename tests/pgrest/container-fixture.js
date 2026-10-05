// Optional, explicitly selected test infrastructure. Never discover application
// containers, pull images, create containers, or change their networking/volumes.
import { execFileSync } from 'node:child_process';
import { createConnection, isIP } from 'node:net';
import { dockerCommand } from '../docker.js';

export const pgContainer = process.env.PGREST_TEST_CONTAINER || 'pgrest-nginz-test';
export const pgAdmin = process.env.PGREST_TEST_ADMIN || 'postgres';
export function docker(args, input, encoding = 'utf8') {
    const [command,...prefix]=dockerCommand();
    return execFileSync(command,[...prefix,...args],{input,encoding,timeout:30000,maxBuffer:64e6,stdio:['pipe','pipe','pipe']});
}
export function adminArgs(database='postgres') {
    return ['exec','-i',pgContainer,'psql','-XqAt','-U',pgAdmin,'-d',database,'-v','ON_ERROR_STOP=1',
        ...(process.env.PGREST_TEST_CONTAINER_PORT ? ['-p',String(portNumber(process.env.PGREST_TEST_CONTAINER_PORT))] : [])];
}
function portNumber(value) {
    const port=Number(value);
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('PostgreSQL test port must be 1–65535');
    return port;
}
function safeHost(host) {
    if(!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host))throw Error('Invalid PostgreSQL test host');
    return host;
}
export function dataVolume(info,data) {
    return (info.Mounts||[]).filter(m=>m.Type==='volume'&&m.RW&&(data===m.Destination||data.startsWith(m.Destination+'/')))
        .sort((a,b)=>b.Destination.length-a.Destination.length)[0];
}
export function endpoints(info,port,{host,hostPort,daemonHost='127.0.0.1'}={}) {
    const direct=info.HostConfig.NetworkMode==='host' ? [{host:daemonHost,port}] :
        Object.values(info.NetworkSettings.Networks||{}).flatMap(n=>[n.IPAddress,n.GlobalIPv6Address].filter(Boolean).map(host=>({host,port})));
    const published=(info.NetworkSettings.Ports?.[port+'/tcp']||[]).map(p=>({
        host:['0.0.0.0','::',''].includes(p.HostIp)?daemonHost:p.HostIp,port:portNumber(p.HostPort),
    }));
    const candidates=host!==undefined||hostPort!==undefined ? [{host:safeHost(host||daemonHost),port:portNumber(hostPort??published[0]?.port??port)}] : [...published,...direct];
    return {direct,candidates};
}
export async function reachable(host,port) {
    return new Promise(done=>{
        const socket=createConnection({host,port});
        const finish=ok=>{socket.destroy();done(ok);};
        socket.setTimeout(1000,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
    });
}
let discovered;
export function postgresFixture(){return discovered ??= discover();}
async function discover() {
    // Invalid explicit configuration is an error, not an unavailable dependency.
    if(process.env.PGREST_TEST_HOST)safeHost(process.env.PGREST_TEST_HOST);
    for(const key of ['PGREST_TEST_PORT','PGREST_TEST_CONTAINER_PORT'])if(process.env[key])portNumber(process.env[key]);
    let info,data,port,admin;
    try{dockerCommand();}catch{return {skip:'Docker is unavailable'};}
    try{info=JSON.parse(docker(['inspect',pgContainer]))[0];}
    catch{return {skip:`test container ${pgContainer} is unavailable`};}
    try{
        if(!info.State.Running){docker(['start',pgContainer]);info=JSON.parse(docker(['inspect',pgContainer]))[0];}
        let output;
        for(let attempt=0;attempt<20;attempt++){
            try{output=docker(adminArgs(),"SELECT current_setting('data_directory'),current_setting('port'),rolsuper FROM pg_roles WHERE rolname=current_user;").trim().split('|');break;}
            catch(error){if(attempt===19)throw error;await new Promise(done=>setTimeout(done,100));}
        }
        [data,port,admin]=output;port=portNumber(port);
    }catch{return {skip:`test container ${pgContainer} is not ready for psql administrator access`};}
    if(admin!=='t')return {skip:`${pgAdmin} must be a superuser in the disposable test container`};
    const mount=dataVolume(info,data);
    if(!mount)return {skip:`test container ${pgContainer} needs a writable named data volume`};
    let daemonHost='127.0.0.1';
    try{
        const endpoint=process.env.DOCKER_HOST||JSON.parse(docker(['context','inspect']))[0].Endpoints.docker.Host;
        if(/^(tcp|http|https|ssh):/.test(endpoint))daemonHost=new URL(endpoint).hostname.replace(/^\[|\]$/g,'');
    }catch{return {skip:'Docker daemon address is unavailable'};}
    const address=endpoints(info,port,{host:process.env.PGREST_TEST_HOST,hostPort:process.env.PGREST_TEST_PORT,daemonHost});
    let selected,directHost;
    for(const candidate of address.candidates)if(await reachable(candidate.host,candidate.port)){selected=candidate;break;}
    if(!selected)return {skip:`test container ${pgContainer} has no reachable PostgreSQL endpoint`};
    for(const candidate of address.direct)if(await reachable(candidate.host,candidate.port)){directHost=candidate.host;break;}
    return {...selected,containerPort:port,directHost,info,mount,dataDirectory:data};
}
export function explainSkip(suite,fixture){if(fixture.skip)console.warn(`[pgrest ${suite}] skipped: ${fixture.skip}`);}
