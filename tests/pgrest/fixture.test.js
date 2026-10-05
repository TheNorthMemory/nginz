import {test,expect} from 'bun:test';
import {dataVolume,endpoints} from './container-fixture.js';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const info=(network,networks={},ports={})=>({HostConfig:{NetworkMode:network},NetworkSettings:{Networks:networks,Ports:ports}});
test('host networking uses the inspected PostgreSQL port and daemon host',()=>{
    expect(endpoints(info('host'),5544,{daemonHost:'test-docker.example'}).candidates).toEqual([{host:'test-docker.example',port:5544}]);
});
test('bridge networking supports published ports and direct container addresses',()=>{
    const fixture=info('bridge',{bridge:{IPAddress:'172.17.0.8'}},{'5432/tcp':[{HostIp:'0.0.0.0',HostPort:'15432'}]});
    expect(endpoints(fixture,5432)).toEqual({direct:[{host:'172.17.0.8',port:5432}],candidates:[{host:'127.0.0.1',port:15432},{host:'172.17.0.8',port:5432}]});
    expect(endpoints(fixture,5432,{host:'db.example',hostPort:25432}).candidates).toEqual([{host:'db.example',port:25432}]);
});
test('private and IPv6 container networks do not depend on a network name',()=>{
    expect(endpoints(info('private',{custom:{IPAddress:'',GlobalIPv6Address:'fd00::2'}}),5555).direct).toEqual([{host:'fd00::2',port:5555}]);
});
test('Docker Desktop published ports work without a reachable container network',()=>{
    expect(endpoints(info('bridge',{}, {'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'15432'}]}),5432)).toEqual({direct:[],candidates:[{host:'127.0.0.1',port:15432}]});
});
test('data volume discovery accepts custom paths and picks the containing nested mount',()=>{
    const outer={Type:'volume',Name:'outer',RW:true,Destination:'/database'},inner={...outer,Name:'inner',Destination:'/database/data'};
    expect(dataVolume({Mounts:[outer,inner]},'/database/data/pgdata')).toEqual(inner);
    expect(dataVolume({Mounts:[outer]},'/database-other')).toBeUndefined();
    expect(dataVolume({Mounts:[{...inner,Type:'bind'},{...inner,RW:false}]},'/database/data')).toBeUndefined();
});
test('invalid explicit endpoints cannot enter generated nginx configuration',()=>{
    expect(()=>endpoints(info('host'),5432,{host:'localhost";'})).toThrow();
    expect(()=>endpoints(info('host'),5432,{hostPort:0})).toThrow();
    expect(()=>endpoints(info('host'),5432,{hostPort:70000})).toThrow();
});

for(const available of [false,true])test(available?'missing container is an explicit optional-fixture skip':'missing Docker is an explicit optional-fixture skip',()=>{
    const directory=mkdtempSync(join(tmpdir(),'pgrest-prerequisites-'));
    try{
        mkdirSync(join(directory,'bin'));
        writeFileSync(join(directory,'bin/docker'),'#!/bin/sh\n'+(available?'if [ "$1" = info ]; then echo fixture; exit 0; fi\n':'')+'exit 1\n',{mode:0o700});
        writeFileSync(join(directory,'bin/sudo'),'#!/bin/sh\nexit 1\n',{mode:0o700});
        const env={...process.env,PATH:join(directory,'bin')+':'+process.env.PATH,PGREST_TEST_CONTAINER:'optional-fixture'};
        for(const name of ['PGREST_TEST_HOST','PGREST_TEST_PORT','PGREST_TEST_CONTAINER_PORT'])delete env[name];
        const child=spawnSync(process.execPath,['--eval',`const {postgresFixture}=await import(${JSON.stringify(new URL('./container-fixture.js',import.meta.url).href)}); console.log(JSON.stringify(await postgresFixture()));`],{env,encoding:'utf8',timeout:10000});
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({skip:available?'test container optional-fixture is unavailable':'Docker is unavailable'});
    }finally{rmSync(directory,{recursive:true,force:true});}
});
