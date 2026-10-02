const std = @import("std");
const ngx = @import("ngx");
const core = ngx.core;
const CJSON = ngx.cjson.CJSON;

const XmlReader = opaque {};
extern fn xmlReaderForMemory([*]const u8, c_int, ?[*:0]const u8, ?[*:0]const u8, c_int) ?*XmlReader;
extern fn xmlFreeTextReader(*XmlReader) void;
extern fn xmlTextReaderRead(*XmlReader) c_int;
extern fn xmlTextReaderNodeType(*XmlReader) c_int;
extern fn xmlTextReaderDepth(*XmlReader) c_int;
extern fn xmlTextReaderConstName(*XmlReader) ?[*:0]const u8;
extern fn xmlTextReaderConstValue(*XmlReader) ?[*:0]const u8;
extern fn xmlTextReaderIsEmptyElement(*XmlReader) c_int;

fn allocate(pool: [*c]core.ngx_pool_t, length: usize) ![]u8 {
    const pointer = core.castPtr(u8, core.ngx_pnalloc(pool, @max(length, 1))) orelse return core.NError.OOM;
    return pointer[0..length];
}

fn decodeBase64(pool: [*c]core.ngx_pool_t, encoded: []const u8) ![]u8 {
    if (encoded.len == 0 or encoded.len % 4 != 0) return error.InvalidMessage;
    const padding: usize = if (std.mem.endsWith(u8, encoded, "==")) 2 else if (std.mem.endsWith(u8, encoded, "=")) 1 else 0;
    for (encoded[0 .. encoded.len - padding]) |c| {
        if (!std.ascii.isAlphanumeric(c) and c != '+' and c != '/') return error.InvalidMessage;
    }
    const decoded = try allocate(pool, encoded.len / 4 * 3);
    var destination = ngx.string.ngx_string(decoded);
    var source = ngx.string.ngx_string(encoded);
    if (ngx.string.ngx_decode_base64(&destination, &source) != core.NGX_OK) return error.InvalidMessage;
    const canonical = try allocate(pool, encoded.len);
    var reencoded = ngx.string.ngx_string(canonical);
    ngx.string.ngx_encode_base64(&reencoded, &destination);
    if (reencoded.len != encoded.len or !std.mem.eql(u8, canonical, encoded)) return error.InvalidMessage;
    return decoded[0..destination.len];
}

pub fn configurationKey(pool: [*c]core.ngx_pool_t, appid: []const u8, token: []const u8, encoded_key: []const u8) ![]u8 {
    if (appid.len == 0 or appid.len > 128 or token.len < 3 or token.len > 32 or encoded_key.len != 43)
        return error.InvalidConfiguration;
    for (appid) |c| if (!std.ascii.isAlphanumeric(c) and c != '_' and c != '-') return error.InvalidConfiguration;
    for (token) |c| if (!std.ascii.isAlphanumeric(c)) return error.InvalidConfiguration;
    var padded: [44]u8 = undefined;
    @memcpy(padded[0..43], encoded_key);
    padded[43] = '=';
    const key = try decodeBase64(pool, &padded);
    if (key.len != 32) return error.InvalidConfiguration;
    return key;
}

fn unescape(pool: [*c]core.ngx_pool_t, encoded: []const u8) ![]const u8 {
    const output = try allocate(pool, encoded.len);
    var input_index: usize = 0;
    var output_index: usize = 0;
    while (input_index < encoded.len) : (output_index += 1) {
        const c = encoded[input_index];
        if (c == '%') {
            if (input_index + 2 >= encoded.len) return error.InvalidMessage;
            output[output_index] = std.fmt.parseInt(u8, encoded[input_index + 1 .. input_index + 3], 16) catch return error.InvalidMessage;
            input_index += 3;
        } else {
            output[output_index] = if (c == '+') ' ' else c;
            input_index += 1;
        }
    }
    return output[0..output_index];
}

/// Reject duplicate security arguments, including percent-encoded aliases.
pub fn argument(r: [*c]ngx.http.ngx_http_request_t, name: []const u8) ![]const u8 {
    var answer: ?[]const u8 = null;
    var fields = std.mem.splitScalar(u8, core.slicify(u8, r.*.args.data, r.*.args.len), '&');
    while (fields.next()) |field| {
        const separator = std.mem.indexOfScalar(u8, field, '=') orelse field.len;
        const key = try unescape(r.*.pool, field[0..separator]);
        if (!std.mem.eql(u8, key, name)) continue;
        if (answer != null) return error.InvalidMessage;
        answer = try unescape(r.*.pool, if (separator < field.len) field[separator + 1 ..] else "");
    }
    return answer orelse error.InvalidMessage;
}

pub fn verify(pool: [*c]core.ngx_pool_t, token: []const u8, timestamp: []const u8, nonce: []const u8, encrypted: []const u8, signature: []const u8) !void {
    if (timestamp.len == 0 or nonce.len == 0 or signature.len != 40) return error.InvalidMessage;
    for (timestamp) |c| if (!std.ascii.isDigit(c)) return error.InvalidMessage;
    var parts = [_][]const u8{ token, timestamp, nonce, encrypted };
    for (1..parts.len) |i| {
        var j = i;
        while (j > 0 and std.mem.order(u8, parts[j - 1], parts[j]) == .gt) : (j -= 1) {
            std.mem.swap([]const u8, &parts[j - 1], &parts[j]);
        }
    }
    const joined = try allocate(pool, token.len + timestamp.len + nonce.len + encrypted.len);
    var offset: usize = 0;
    for (parts) |part| {
        @memcpy(joined[offset .. offset + part.len], part);
        offset += part.len;
    }
    const expected = std.fmt.bytesToHex(try ngx.ssl.sha1(joined), .lower);
    if (!ngx.ssl.timingSafeEql(&expected, signature)) return error.InvalidMessage;
}

pub fn encryptedBody(pool: [*c]core.ngx_pool_t, body: []const u8) ![]const u8 {
    const trimmed = std.mem.trim(u8, body, " \t\r\n");
    if (trimmed.len == 0) return error.InvalidMessage;
    if (trimmed[0] == '{') {
        var json = CJSON.init(pool);
        const object = try json.decodeStrict(ngx.string.ngx_string(body));
        if (CJSON.objValue(object) == null) return error.InvalidMessage;
        const value = CJSON.stringValue(ngx.cjson.cJSON_GetObjectItemCaseSensitive(object, "Encrypt")) orelse return error.InvalidMessage;
        return core.slicify(u8, value.data, value.len);
    }
    if (trimmed[0] != '<' or body.len > std.math.maxInt(c_int)) return error.InvalidMessage;
    // NONET, NOERROR, NOWARNING; no DTD loading or entity substitution.
    const reader = xmlReaderForMemory(body.ptr, @intCast(body.len), null, null, 2048 | 32 | 64) orelse return error.InvalidMessage;
    defer xmlFreeTextReader(reader);
    var root = false;
    var found = false;
    var inside = false;
    const output = try allocate(pool, body.len);
    var length: usize = 0;
    while (true) {
        const rc = xmlTextReaderRead(reader);
        if (rc == 0) break;
        if (rc != 1) return error.InvalidMessage;
        const kind = xmlTextReaderNodeType(reader);
        const depth = xmlTextReaderDepth(reader);
        if (kind == 10 or kind == 5 or depth > 2) return error.InvalidMessage;
        if (kind == 1) {
            const name = std.mem.span(xmlTextReaderConstName(reader) orelse return error.InvalidMessage);
            if (depth == 0) {
                if (root or !std.mem.eql(u8, name, "xml")) return error.InvalidMessage;
                root = true;
            } else if (depth == 1 and std.mem.eql(u8, name, "Encrypt")) {
                if (found or xmlTextReaderIsEmptyElement(reader) == 1) return error.InvalidMessage;
                found = true;
                inside = true;
            } else if (inside) return error.InvalidMessage;
        } else if (kind == 15 and depth == 1) {
            inside = false;
        } else if (inside and (kind == 3 or kind == 4 or kind == 13 or kind == 14)) {
            const text = std.mem.span(xmlTextReaderConstValue(reader) orelse return error.InvalidMessage);
            if (text.len > output.len - length) return error.InvalidMessage;
            @memcpy(output[length .. length + text.len], text);
            length += text.len;
        }
    }
    if (!root or !found or inside or length == 0) return error.InvalidMessage;
    return output[0..length];
}

pub fn decrypt(pool: [*c]core.ngx_pool_t, key: []const u8, appid: []const u8, encrypted: []const u8) ![]const u8 {
    const ciphertext = try decodeBase64(pool, encrypted);
    if (ciphertext.len < 32 or ciphertext.len % 32 != 0) return error.InvalidMessage;
    const plaintext = try ngx.ssl.aes256CbcDecrypt(pool, key, ciphertext);
    const padding: usize = plaintext[plaintext.len - 1];
    if (padding == 0 or padding > 32 or plaintext.len - padding < 20) return error.InvalidMessage;
    for (plaintext[plaintext.len - padding ..]) |c| if (c != padding) return error.InvalidMessage;
    const length = std.mem.readInt(u32, plaintext[16..20], .big);
    const end = plaintext.len - padding;
    if (length == 0 or length > end - 20 or !std.mem.eql(u8, plaintext[20 + length .. end], appid)) return error.InvalidMessage;
    return plaintext[20 .. 20 + length];
}
