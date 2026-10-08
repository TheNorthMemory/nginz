async function query(r) {
    const target = r.args.raw === '1' ? '/proxy-raw' : '/proxy';
    const reply = await r.subrequest(target, {
        method: 'POST',
        body: r.requestText || '',
    });
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify({
        status: reply.status,
        verification: reply.variables.wechatpay_verification,
        body: reply.responseText,
    }));
}

async function auditQuery(r) {
    const target = r.args.bounded === '1' ? '/proxy-audit-bounded' : '/proxy-audit';
    const options = { method: r.args.method || 'GET' };
    // Empty bodies can have a null backing pointer in nginx. Pass an empty
    // string without invoking the upstream empty-Buffer constructor; for a
    // nonempty body use the Buffer so malformed UTF-8 stays byte-exact.
    if (r.args.omit !== '1') options.body = r.requestText ? r.requestBuffer : '';
    const reply = await r.subrequest(target + (r.args.deny === '1' ? '?deny-audit=1' : ''), options);
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify({
        status: reply.status,
        verification: reply.variables.wechatpay_verification,
        body: reply.responseText,
        request: rawHex(reply, 'wechatpay_request'),
        response: rawHex(reply, 'wechatpay_response'),
        audit: rawHex(reply, 'test_payment_audit'),
    }));
}

function rawHex(r, name) {
    const value = r.rawVariables[name];
    return value === undefined ? '' : value.toString('hex');
}

function audit(r) {
    const evidence = r.variables.wechatpay_request;
    r.rawVariables.test_payment_audit = r.rawVariables.wechatpay_request;
    r.return(evidence.includes('deny-audit') ? 503 : 204);
}

export default { query, auditQuery, audit };
