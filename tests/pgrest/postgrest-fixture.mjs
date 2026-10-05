// Synthetic conformance fixtures, installed only in disposable audit databases.
// Keep these independent of application RPCs and match the pinned 16.4 oracle.
export function probeSQL(s, ns) {
    return `CREATE TABLE ${s}.audit_rows(id integer PRIMARY KEY, value text NOT NULL CHECK(value<>'bad'));
        INSERT INTO ${s}.audit_rows VALUES(1,'one'),(2,'two');
        GRANT SELECT,INSERT,UPDATE,DELETE ON ${s}.audit_rows TO ${ns}_weapp;
        CREATE FUNCTION ${s}.audit_text(value text DEFAULT 'default') RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('value',value)$$;
        CREATE FUNCTION ${s}.audit_int(value integer) RETURNS integer LANGUAGE sql STABLE AS $$SELECT value$$;
        CREATE FUNCTION ${s}.audit_bigint(value bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('value',value::text)$$;
        CREATE FUNCTION ${s}.audit_variadic_json(VARIADIC value integer[]) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT to_jsonb(value)$$;
        CREATE FUNCTION ${s}.audit_variadic_mixed(prefix text, VARIADIC value integer[]) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('prefix',prefix,'value',value)$$;
        CREATE FUNCTION ${s}.audit_many(${Array.from({length:20},(_,i)=>`a${i} integer`).join(',')}) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_array(${Array.from({length:20},(_,i)=>`a${i}`).join(',')})$$;
        CREATE FUNCTION ${s}.audit_json(jsonb) RETURNS jsonb LANGUAGE sql VOLATILE AS $$SELECT $1$$;
        CREATE FUNCTION ${s}.audit_named_json(value jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT value$$;
        CREATE FUNCTION ${s}.audit_over(a text) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'a:'||a$$;
        CREATE FUNCTION ${s}.audit_over(b integer) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'b:'||b$$;
        CREATE FUNCTION ${s}.audit_typed(value integer) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'int:'||value$$;
        CREATE FUNCTION ${s}.audit_typed(value text) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'text:'||value$$;
        CREATE FUNCTION ${s}.audit_pair(a text,b text DEFAULT 'default') RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_array(a,b)$$;
        CREATE FUNCTION ${s}.audit_variadic(VARIADIC value integer[]) RETURNS integer[] LANGUAGE sql STABLE AS $$SELECT value$$;
        CREATE FUNCTION ${s}.audit_set() RETURNS SETOF integer LANGUAGE sql STABLE AS $$SELECT generate_series(1,3)$$;
        CREATE FUNCTION ${s}.audit_table() RETURNS SETOF ${s}.audit_rows LANGUAGE sql STABLE AS $$SELECT * FROM ${s}.audit_rows ORDER BY id$$;
        CREATE FUNCTION ${s}.audit_null() RETURNS text LANGUAGE sql STABLE AS $$SELECT NULL::text$$;
        CREATE FUNCTION ${s}.audit_void() RETURNS void LANGUAGE sql VOLATILE AS $$SELECT NULL$$;
        CREATE FUNCTION ${s}.audit_volatile_read() RETURNS integer LANGUAGE sql VOLATILE AS $$SELECT 7$$;
        CREATE FUNCTION ${s}.audit_write() RETURNS integer LANGUAGE plpgsql VOLATILE AS $$BEGIN UPDATE ${s}.audit_rows SET value='changed' WHERE id=1; RETURN 1; END$$;
        CREATE FUNCTION ${s}.audit_stable_write() RETURNS integer LANGUAGE sql STABLE AS $$SELECT ${s}.audit_write()$$;
        CREATE FUNCTION ${s}.audit_context() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('jwt',nullif(current_setting('request.jwt',true),'') IS NOT NULL,'claims',nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL,'method',current_setting('request.method',true),'read_only',current_setting('transaction_read_only'))$$;
        CREATE FUNCTION ${s}.audit_http_context() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('method',current_setting('request.method',true),'path',current_setting('request.path',true),'header',current_setting('request.headers',true)::jsonb->>'x-test','cookies',current_setting('request.cookies',true)::jsonb)$$;
        CREATE FUNCTION ${s}.audit_response() RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN PERFORM set_config('response.status','202',true); PERFORM set_config('response.headers','[{"X-Audit":"yes"}]',true); RETURN '{"ok":true}'::jsonb; END$$;
        CREATE FUNCTION ${s}.audit_error(code text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION USING ERRCODE=code,MESSAGE='audit rejection',DETAIL='audit detail',HINT='audit hint'; END$$;
        CREATE FUNCTION ${s}.audit_custom_error() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RAISE SQLSTATE 'PGRST' USING MESSAGE='{"code":"CUSTOM","message":"custom rejection","details":"detail","hint":"hint"}',DETAIL='{"status":402,"headers":{"X-Audit":"custom"}}'; END$$;
        CREATE FUNCTION ${s}.audit_response_media() RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN PERFORM set_config('response.headers','[{"Content-Type":"application/custom+json"},{"Content-Range":"custom"}]',true); RETURN '{"ok":true}'::jsonb; END$$;
        CREATE FUNCTION ${s}.audit_atomic() RETURNS integer LANGUAGE plpgsql VOLATILE AS $$BEGIN UPDATE ${s}.audit_rows SET value='leaked' WHERE id=2; RAISE SQLSTATE 'PT409'; END$$;
        CREATE TABLE ${s}.audit_deferred(id integer REFERENCES ${s}.audit_rows(id) DEFERRABLE INITIALLY DEFERRED);
        GRANT SELECT,INSERT,DELETE ON ${s}.audit_deferred TO ${ns}_weapp;
        CREATE FUNCTION ${s}.audit_commit_failure() RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN INSERT INTO ${s}.audit_deferred VALUES(999); PERFORM set_config('response.headers','[{"X-Audit":"must-not-leak"}]',true); RETURN '{"ok":true}'::jsonb; END$$;
        CREATE FUNCTION ${s}.audit_bad_response(kind text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN UPDATE ${s}.audit_rows SET value='must-rollback' WHERE id=1; IF kind='status' THEN PERFORM set_config('response.status','invalid',true); ELSE PERFORM set_config('response.headers','{}',true); END IF; RETURN '{"ok":true}'::jsonb; END$$;
        CREATE FUNCTION ${s}.audit_sleep(delay real) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN PERFORM pg_sleep(delay); RETURN '{"ok":true}'::jsonb; END$$;
        CREATE TABLE ${s}.audit_counter(value integer NOT NULL); INSERT INTO ${s}.audit_counter VALUES(0);
        GRANT SELECT,UPDATE ON ${s}.audit_counter TO ${ns}_weapp;
        CREATE FUNCTION ${s}.audit_counted_write() RETURNS SETOF integer LANGUAGE plpgsql VOLATILE AS $$BEGIN UPDATE ${s}.audit_counter SET value=value+1; RETURN QUERY SELECT generate_series(1,3); END$$;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${ns}_weapp;`;
}
