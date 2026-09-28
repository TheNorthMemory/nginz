async function forward(r) {
    const reply = await r.subrequest('/rpc/' + r.args.fn, {
        args: 'bytes=' + (r.args.bytes || '600000'),
    });
    r.headersOut['Content-Type'] = 'application/json';
    r.return(reply.status, reply.responseText);
}

export default { forward };
