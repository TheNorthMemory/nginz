// Synthetic credentials only. This reference follows the current njs
// SHA-1/WebCrypto CBC path, including its WeChat 32-byte padding workaround.
const TOKEN = 'NotifyFixtureToken';
const APPID = 'wx0123456789abcdef';
const ENCODED_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

function consume(r, plaintext) {
    if (JSON.parse(plaintext).Event !== 'benchmark') throw new Error('invalid event');
    r.headersOut['Content-Type'] = 'text/plain';
    r.return(200, 'success');
}

async function native(r) {
    consume(r, await r.readRequestText());
}

async function njs(r) {
    try {
        const envelope = await r.readRequestJSON();
        const encrypted = envelope.Encrypt;
        const { timestamp, nonce, msg_signature, encrypt_type } = r.args;
        if (typeof encrypted !== 'string' || !timestamp || !nonce || encrypt_type !== 'aes' || msg_signature.length !== 40)
            throw new Error('invalid signature');
        const digest = Buffer.from(await crypto.subtle.digest('SHA-1',
            Buffer.from([TOKEN, timestamp, nonce, encrypted].sort().join('')))).toString('hex');
        let equal = true;
        for (let i = 0; i < 40; i++) equal = (digest[i] === msg_signature[i]) && equal;
        if (!equal) throw new Error('invalid signature');

        const keyBytes = Buffer.from(ENCODED_KEY + '=', 'base64');
        const ciphertext = Buffer.from(encrypted, 'base64');
        if (ciphertext.length < 32 || ciphertext.length % 16 !== 0) throw new Error('invalid ciphertext');
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
        const tail = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ciphertext.subarray(ciphertext.length - 16) }, key, Buffer.alloc(0));
        const combined = Buffer.concat([ciphertext, Buffer.from(tail).subarray(0, 16)]);
        const plaintext = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: keyBytes.subarray(0, 16) }, key, combined));
        const padding = plaintext[plaintext.length - 1];
        if (padding < 1 || padding > 32 || plaintext.length - padding < 20) throw new Error('invalid padding');
        for (let i = plaintext.length - padding; i < plaintext.length; i++)
            if (plaintext[i] !== padding) throw new Error('invalid padding');
        const length = plaintext.readUInt32BE(16);
        if (length < 1 || length > plaintext.length - padding - 20 || plaintext.subarray(20 + length, plaintext.length - padding).toString() !== APPID)
            throw new Error('invalid appid or length');
        consume(r, plaintext.subarray(20, 20 + length).toString());
    } catch {
        r.return(403, 'invalid notification');
    }
}

export default { native, njs };
