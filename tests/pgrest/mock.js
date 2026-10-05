// Wire mock support for pgrest's transaction and type-aware JSON envelopes.
// SQL grammar fixtures remain explicit in the suites. Real PostgreSQL and the
// pinned PostgREST differential suite establish SQL and transaction semantics.
import { PostgresMock } from '../mocks/postgres.js';

export function dataSql(query) {
  if(query === undefined)return null;
  const match=query.match(/^WITH pgrst_source AS (?:MATERIALIZED )?\(([\s\S]*)\) SELECT (?:jsonb_strip_nulls\()?to_jsonb\(pgrst_source\)/);
  return match ? match[1] : query;
}

class PgrestMock extends PostgresMock {
  handleQuery(socket, query, sendReady=true) {
    // Preserve actual wire queries for assertions and debugging.
    this.queryLog.push(query);
    const ready=()=>{if(sendReady)this.write(socket,Buffer.from([0x5a,0,0,0,5,0x49]));};
    if(query.startsWith('BEGIN ')) {
      for(const statement of query.split(';'))this.trackSetupStatement(statement.trim().replace(/^SET LOCAL /,'SET '));
      this.sendCommandComplete(socket,'BEGIN');ready();return;
    }
    if(query.startsWith("SELECT current_setting('response.status'")) {
      this.sendQueryResult(socket,['status','headers'],[['','']]);ready();return;
    }
    const counted=query.match(/^WITH pgrst_source AS MATERIALIZED \(([\s\S]*)\), pgrst_page AS MATERIALIZED \(TABLE pgrst_source(?: LIMIT (\d+))? OFFSET (\d+)\)/);
    const inner=counted?counted[1]:dataSql(query);
    if(inner!==query) {
      const result=this.resultFor(inner);
      if(result.error){this.sendError(socket,result.error);ready();return;}
      if(result.close){socket.end();return;}
      const scalar=query.match(/to_jsonb\(pgrst_(?:source|page)\)(?:\))?->'([^']+)'/);
      const rows=result.rows.map(row=>{
        const object=Object.fromEntries(result.columns.map((column,index)=>{
          const name=typeof column==='string'?column:column.name;
          let value=row[index];
          if(value!==null && [114,3802].includes(column.typeOid))value=JSON.parse(value);
          return [name,value];
        }));
        const value=scalar?object[scalar[1]]??null:object;
        if(query.includes('jsonb_strip_nulls')&&value&&typeof value==='object')for(const key of Object.keys(value))if(value[key]===null)delete value[key];
        return value;
      });
      if(counted) {
        const start=Number(counted[3]),limit=counted[2]===undefined?rows.length:Number(counted[2]);
        const page=rows.slice(start,start+limit);
        this.sendQueryResult(socket,['json','page_count','total'],[[JSON.stringify(query.includes("'[]'::jsonb)->0")?page[0]??null:page),String(page.length),String(rows.length)]]);
      } else this.sendQueryResult(socket,[{name:'pgrst_json',typeOid:3802}],rows.map(value=>[JSON.stringify(value)]));
      ready();return;
    }
    // Delegate unwrapped queries to explicit fixtures and normal wire handling.
    super.handleSingleQuery(socket,query,sendReady);
  }

  resultFor(query) {
    for(const [pattern,handler] of this.queryHandlers)if(pattern.test(query))return handler(query);
    let captured;
    const send=this.sendQueryResult;
    this.sendQueryResult=(_socket,columns,rows)=>{captured={columns,rows};};
    try { super.handleSelect({},query); } finally {this.sendQueryResult=send;}
    return captured??{columns:[],rows:[]};
  }
}
export function createPostgresMock(port){return new PgrestMock(port).start();}
