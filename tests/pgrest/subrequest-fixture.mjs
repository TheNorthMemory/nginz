function snapshot(reply) {
    var body = reply.responseText;
    try { body = JSON.parse(body); } catch (_) {}
    return { status: reply.status, body: body };
}

async function mixed(r) {
    var label = r.args.label;
    var results = [];
    results.push(snapshot(await r.subrequest('/db/items', { method: 'POST', body: JSON.stringify({ label: label, value: 1 }) })));
    results.push(snapshot(await r.subrequest('/db/items?label=eq.' + label, { method: 'PATCH', body: '{"value":2}' })));
    results.push(snapshot(await r.subrequest('/db/rpc/add_them', { method: 'POST', body: '{"a":1,"b":2}' })));
    results.push(snapshot(await r.subrequest('/db/items?label=eq.' + label, { method: 'GET' })));
    results.push(snapshot(await r.subrequest('/db/items?label=eq.' + label, { method: 'DELETE' })));
    results.push(snapshot(await r.subrequest('/db/items?label=eq.' + label, { method: 'GET' })));
    r.return(200, JSON.stringify(results));
}

async function siblings(r) {
    var pending = [];
    for (var i = 0; i < 8; i++) {
        pending.push(r.subrequest('/db/rpc/context?value=' + i + '&delay=0.02', { method: 'GET' }));
    }
    var replies = await Promise.all(pending);
    r.return(200, JSON.stringify(replies.map(snapshot)));
}

async function recover(r) {
    var results = [];
    results.push(snapshot(await r.subrequest('/db/rpc/fail', { method: 'GET' })));
    results.push(snapshot(await r.subrequest('/db/rpc/add_them?a=1&b=2', { method: 'GET' })));
    results.push(snapshot(await r.subrequest('/db/rpc/write', { method: 'POST', body: '{"label":"invalid-header","bad":true}' })));
    results.push(snapshot(await r.subrequest('/db/rpc/add_them?a=1&b=2', { method: 'GET' })));
    r.return(200, JSON.stringify(results));
}

async function head(r) {
    var fn = r.args.fn || 'add_them';
    var reply = await r.subrequest('/db/rpc/' + fn + (fn === 'add_them' ? '?a=1&b=2' : ''), { method: 'HEAD' });
    r.return(200, JSON.stringify({ status: reply.status, body: reply.responseText }));
}

function detached(r) {
    r.subrequest('/db/rpc/write', { method: 'POST', body: r.requestText, detached: true });
    r.return(202, 'accepted');
}

export default { mixed, siblings, recover, head, detached };
