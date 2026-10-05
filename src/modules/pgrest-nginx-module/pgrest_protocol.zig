//! PostgREST's SQLSTATE/HTTP contract, independent of application schemas.
const std = @import("std");

pub fn sql_status(code: []const u8, message: []const u8, authenticated: bool) usize {
    if (std.mem.eql(u8, code, "23503") or std.mem.eql(u8, code, "23505")) return 409;
    if (std.mem.eql(u8, code, "25006")) return 405;
    if (std.mem.eql(u8, code, "21000")) return if (std.mem.endsWith(u8, message, "requires a WHERE clause")) 400 else 500;
    if (std.mem.eql(u8, code, "22023")) return if (std.mem.startsWith(u8, message, "role") and std.mem.endsWith(u8, message, "does not exist")) 401 else 400;
    if (std.mem.eql(u8, code, "53400") or std.mem.eql(u8, code, "42P17")) return 500;
    if (std.mem.eql(u8, code, "57P01")) return 503;
    if (std.mem.eql(u8, code, "P0001")) return 400;
    if (std.mem.eql(u8, code, "42883")) return if (std.mem.startsWith(u8, message, "function xmlagg(")) 406 else 404;
    if (std.mem.eql(u8, code, "42P01")) return 404;
    if (std.mem.eql(u8, code, "42501")) return if (authenticated) 403 else 401;
    if (code.len != 5) return 500;
    if (std.mem.startsWith(u8, code, "PT")) return std.fmt.parseInt(usize, code[2..], 10) catch 500;
    for ([_][]const u8{ "08", "53" }) |prefix| if (std.mem.startsWith(u8, code, prefix)) return 503;
    for ([_][]const u8{ "0L", "0P", "28" }) |prefix| if (std.mem.startsWith(u8, code, prefix)) return 403;
    for ([_][]const u8{ "09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "P0", "XX" }) |prefix| if (std.mem.startsWith(u8, code, prefix)) return 500;
    return 400;
}

test "SQLSTATE mapping distinguishes rejected input, database faults and custom statuses" {
    for ([_][]const u8{ "23502", "23514", "P0001", "22023", "42601" }) |code| try std.testing.expectEqual(@as(usize, 400), sql_status(code, "test", true));
    try std.testing.expectEqual(@as(usize, 418), sql_status("PT418", "teapot", true));
    try std.testing.expectEqual(@as(usize, 405), sql_status("25006", "read only", true));
    try std.testing.expectEqual(@as(usize, 503), sql_status("53300", "capacity", true));
    try std.testing.expectEqual(@as(usize, 500), sql_status("53400", "configuration", true));
    try std.testing.expectEqual(@as(usize, 401), sql_status("42501", "permission denied", false));
    try std.testing.expectEqual(@as(usize, 403), sql_status("42501", "permission denied", true));
}
