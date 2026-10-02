async function receive(r) {
    const body = await r.readRequestText();
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify({
        body,
        contentType: r.headersIn['Content-Type'],
        contentLength: r.headersIn['Content-Length'],
        verifiedBody: r.variables.wechat_notify_body,
        verification: r.variables.wechat_notify_verification,
        appid: r.variables.wechat_notify_appid,
    }));
}

async function subrequest(r) {
    const reply = await r.subrequest('/echo', { method: 'POST', body: '{}' });
    r.return(200, String(reply.status));
}

export default { receive, subrequest };
