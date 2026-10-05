// Inspect local prerequisites only. The caller owns the temporary container;
// image absence must skip before any database or container is created.
import {docker,pgContainer} from './container-fixture.js';
import {isIP} from 'node:net';

export function postgrestNetwork(database) {
    const host=database.directHost||database.daemonHost;
    if(database.info.HostConfig.NetworkMode==='host')return {
        network:'host',host,dbHost:host,
        serverHost:['127.0.0.1','localhost','::1'].includes(database.daemonHost)?(isIP(host)===6?'::1':'127.0.0.1'):(isIP(host)===6?'::':'0.0.0.0'),publish:false,
    };
    if(database.directHost)return {
        network:'container:'+pgContainer,host:database.directHost,dbHost:database.directHost,
        serverHost:isIP(database.directHost)===6?'::':'0.0.0.0',publish:false,
    };
    // Docker Desktop cannot expose a container IP to the test runner. Attach
    // to the fixture's existing network and publish a loopback HTTP port.
    const network=Object.entries(database.info.NetworkSettings.Networks||{}).find(([,n])=>n.IPAddress||n.GlobalIPv6Address);
    if(network&&['127.0.0.1','localhost','::1'].includes(database.daemonHost))return {
        network:network[0],host:database.daemonHost,dbHost:network[1].IPAddress||network[1].GlobalIPv6Address,
        serverHost:network[1].IPAddress?'0.0.0.0':'::',publish:true,
    };
    return {skip:'PostgREST spill needs a reachable container address or local Docker loopback port publishing'};
}

export async function postgrestFixture(discoverDatabase,{env=process.env,run=docker}={}) {
    const reference=env.PGREST_SPILL_POSTGREST_IMAGE||'postgrest/postgrest:v16.4';
    let image;
    try{image=JSON.parse(run(['image','inspect',reference]))[0];}
    catch{return {skip:`local PostgREST image ${reference} is unavailable (no automatic pull)`};}
    const database=await discoverDatabase();if(database.skip)return database;
    const network=postgrestNetwork(database);if(network.skip)return network;
    return {...database,backup:network,image:image.Id,imageReference:reference,
        command:image.Config?.Entrypoint?.length?[]:['/bin/postgrest']};
}

export function postgrestContainerArgs(fixture,{name,database,password,secret,port}) {
    const quote=x=>"'"+String(x).replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";
    const environment={
        PGRST_DB_URI:`host=${quote(fixture.backup.dbHost)} port=${fixture.containerPort} dbname=${database} user=${database} password=${password} application_name=spill_backup`,
        PGRST_DB_SCHEMAS:'spill',PGRST_DB_POOL:'1',PGRST_DB_POOL_ACQUISITION_TIMEOUT:'1',PGRST_DB_CHANNEL_ENABLED:'false',
        PGRST_JWT_SECRET:secret,PGRST_JWT_AUD:'spill',PGRST_SERVER_HOST:fixture.backup.serverHost,
        PGRST_SERVER_PORT:String(fixture.backup.publish?3000:port),PGRST_OPENAPI_MODE:'disabled',PGRST_LOG_LEVEL:'crit',
    };
    return ['create','--pull=never','--name',name,'--label','nginz.pgrest.spill='+database,
        '--network',fixture.backup.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        ...(fixture.backup.publish?['--publish','127.0.0.1::3000']:[]),
        ...Object.entries(environment).flatMap(([key,value])=>['--env',key+'='+value]),
        fixture.image,...fixture.command,'+RTS','-N1','-RTS'];
}
