import {test,expect} from 'bun:test';
import {postgrestNetwork,postgrestFixture,postgrestContainerArgs} from './postgrest-fixture.js';
import {pgContainer} from './container-fixture.js';

const database=(mode,{directHost,daemonHost='127.0.0.1',networks={}}={})=>({
    host:'127.0.0.1',port:15432,containerPort:5432,directHost,daemonHost,
    info:{HostConfig:{NetworkMode:mode},NetworkSettings:{Networks:networks}},
});
test('missing image skips before touching PostgreSQL or starting a container',async()=>{
    const calls=[];let databaseTouched=false;
    const found=await postgrestFixture(()=>{databaseTouched=true;throw Error('must not discover PostgreSQL');},{env:{},run:args=>{calls.push(args);throw Error('missing image');}});
    expect(found.skip).toContain('no automatic pull');expect(databaseTouched).toBe(false);
    expect(calls).toEqual([['image','inspect','postgrest/postgrest:v16.4']]);
});
test('available image still skips when the optional PostgreSQL fixture is absent',async()=>{
    const calls=[];
    const found=await postgrestFixture(async()=>({skip:'no PostgreSQL fixture'}),{env:{},run:args=>{calls.push(args);return JSON.stringify([{Id:'local-image'}]);}});
    expect(found).toEqual({skip:'no PostgreSQL fixture'});expect(calls).toHaveLength(1);
});
test('host networking uses the actual database port and a local HTTP listener',()=>{
    expect(postgrestNetwork(database('host',{directHost:'127.0.0.1'}))).toEqual({network:'host',host:'127.0.0.1',dbHost:'127.0.0.1',serverHost:'127.0.0.1',publish:false});
});
test('bridge networking shares the selected fixture namespace without requiring host mode',()=>{
    expect(postgrestNetwork(database('bridge',{directHost:'172.17.0.9'}))).toEqual({network:'container:'+pgContainer,host:'172.17.0.9',dbHost:'172.17.0.9',serverHost:'0.0.0.0',publish:false});
});
test('IPv6 namespace sharing binds an IPv6 HTTP listener',()=>{
    expect(postgrestNetwork(database('custom',{directHost:'fd00::9'})).serverHost).toBe('::');
});
test('IPv6 host networking uses the inspected IPv6 endpoint',()=>{
    expect(postgrestNetwork(database('host',{daemonHost:'::1',directHost:'::1'}))).toEqual({network:'host',host:'::1',dbHost:'::1',serverHost:'::1',publish:false});
});
test('Docker Desktop uses the existing database network and an ephemeral loopback mapping',()=>{
    expect(postgrestNetwork(database('bridge',{networks:{testnet:{IPAddress:'172.17.0.9'}}}))).toEqual({network:'testnet',host:'127.0.0.1',dbHost:'172.17.0.9',serverHost:'0.0.0.0',publish:true});
});
test('unreachable remote container networks skip without changing networking',()=>{
    expect(postgrestNetwork(database('bridge',{daemonHost:'remote.example',networks:{testnet:{IPAddress:'172.17.0.9'}}})).skip).toContain('reachable container address');
});
test('temporary container uses the inspected local image, pull=never and environment configuration',async()=>{
    const calls=[];
    const fixture=await postgrestFixture(async()=>database('host',{directHost:'127.0.0.1'}),{env:{},run:args=>{calls.push(args);return JSON.stringify([{Id:'sha256:local-image',Config:{Entrypoint:null}}]);}});
    const args=postgrestContainerArgs(fixture,{name:'owned-postgrest',database:'owned_db',password:'test-password',secret:'test-secret',port:12345});
    expect(calls).toEqual([['image','inspect','postgrest/postgrest:v16.4']]);
    expect(args.slice(0,4)).toEqual(['create','--pull=never','--name','owned-postgrest']);
    expect(args).toContain('PGRST_DB_URI=host=\'127.0.0.1\' port=5432 dbname=owned_db user=owned_db password=test-password application_name=spill_backup');
    expect(args.slice(-5)).toEqual(['sha256:local-image','/bin/postgrest','+RTS','-N1','-RTS']);
    expect(args).not.toContain('--volume');expect(args).not.toContain('--mount');
});
test('published fallback uses loopback and supports images with an entrypoint',()=>{
    const fixture={...database('bridge'),backup:{network:'testnet',dbHost:'172.17.0.9',serverHost:'0.0.0.0',publish:true},image:'local-image',command:[]};
    const args=postgrestContainerArgs(fixture,{name:'owned',database:'owned_db',password:'password',secret:'secret',port:12345});
    expect(args[args.indexOf('--publish')+1]).toBe('127.0.0.1::3000');
    expect(args).toContain('PGRST_SERVER_PORT=3000');expect(args.slice(-4)).toEqual(['local-image','+RTS','-N1','-RTS']);
});
