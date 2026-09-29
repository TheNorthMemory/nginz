const std = @import("std");

pub fn literal_size(value: []const u8) usize {
    var size = value.len + 2;
    var escape = false;
    for (value) |c| {
        if (c == '\'' or c == '\\') size += 1;
        if (c == '\\') escape = true;
    }
    return size + @intFromBool(escape);
}

/// SQL values normally travel through libpq parameters. Catalog queries,
/// generated array constructors and session setup also need literal quoting.
/// Explicit escape strings keep backslashes safe with either PostgreSQL
/// standard_conforming_strings setting.
pub fn append_literal(out: []u8, start: usize, value: []const u8) usize {
    var pos = start;
    const escape = std.mem.indexOfScalar(u8, value, '\\') != null;
    if (escape) {
        out[pos] = 'E';
        pos += 1;
    }
    out[pos] = '\'';
    pos += 1;
    for (value) |c| {
        if (c == '\'' or (escape and c == '\\')) {
            out[pos] = c;
            pos += 1;
        }
        out[pos] = c;
        pos += 1;
    }
    out[pos] = '\'';
    return pos + 1;
}

/// Append one identifier, never an expression or a schema-qualified name.
/// Preserve the existing spelling of simple lowercase names; everything else
/// is double-quoted, with embedded double quotes doubled.
pub fn append_identifier(out: []u8, start: usize, name: []const u8) usize {
    var simple = name.len > 0;
    for (name, 0..) |c, i| {
        if (!((c >= 'a' and c <= 'z') or c == '_' or (i > 0 and std.ascii.isDigit(c)))) {
            simple = false;
            break;
        }
    }
    if (simple) {
        @memcpy(out[start..][0..name.len], name);
        return start + name.len;
    }
    return append_quoted_identifier(out, start, name);
}

pub fn append_quoted_identifier(out: []u8, start: usize, name: []const u8) usize {
    var pos = start;
    out[pos] = '"';
    pos += 1;
    for (name) |c| {
        if (c == '"') {
            out[pos] = '"';
            pos += 1;
        }
        out[pos] = c;
        pos += 1;
    }
    out[pos] = '"';
    return pos + 1;
}

test "SQL literals escape quotes and backslashes independently of server settings" {
    var output: [256]u8 = undefined;
    const len = append_literal(&output, 0, "\\'; SELECT 1; --");
    try std.testing.expectEqualStrings("E'\\\\''; SELECT 1; --'", output[0..len]);
}

test "identifiers cannot contribute SQL syntax" {
    var output: [256]u8 = undefined;
    const len = append_identifier(&output, 0, "name\" => current_user); --");
    try std.testing.expectEqualStrings("\"name\"\" => current_user); --\"", output[0..len]);
    const mixed_len = append_identifier(&output, 0, "MixedCase");
    try std.testing.expectEqualStrings("\"MixedCase\"", output[0..mixed_len]);
}
