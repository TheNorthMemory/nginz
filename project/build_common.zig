const std = @import("std");
const Io = std.Io;
const OOM = std.mem.Allocator.Error.OutOfMemory;
const ArrayList = std.array_list.Managed;

pub var BUILD_BUFFER: [4096 * 10]u8 = undefined;
pub var STREAM_BUILD_BUFFER: [4096 * 4]u8 = undefined;
pub const C_FLAGS = [_][]const u8{
    "-std=gnu11",
    "-Wall",
    "-Wextra",
    "-Wno-unused-function",
    "-Wno-unused-parameter",
    "-fno-sanitize=all",
    "-DNJS_HAVE_QUICKJS",
};
pub const NGX_INCLUDE_PATH = [_][]const u8{
    "submodules/nginx/objs",
    "submodules/nginx/src/core",
    "submodules/nginx/src/http",
    "submodules/nginx/src/event",
    "submodules/nginx/src/os/unix",
    "submodules/nginx/src/http/v2",
    "submodules/nginx/src/http/v3",
    "submodules/nginx/src/event/quic",
    "submodules/nginx/src/http/modules",
    "submodules/nginx/src/event/modules",
    "submodules/nginx/src/stream",
};

const EXCLUDES = [_][]const u8{
    "bpf",
    "perl",
    "test",
    "nginx.c",
    "modules",
    "njs_shell.c",
    "njs_regex.c",
    "njs_lvlhsh.c",
    "njs_addr2line.c",
    "njs_lexer_keyword.c",
    "ngx_http_geoip_module.c",
    "ngx_stream_geoip_module.c",
    "ngx_http_stub_status_module.c",
    "ngx_http_degradation_module.c",
};

const bundled_nginx_header = @embedFile("../submodules/nginx/src/core/nginx.h");

pub fn bundled_nginx_version() u32 {
    const marker = "#define nginx_version";
    var lines = std.mem.tokenizeAny(u8, bundled_nginx_header, "\r\n");

    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, marker)) continue;

        const tail = line[marker.len..];
        var begin: usize = 0;
        while (begin < tail.len and (tail[begin] == ' ' or tail[begin] == '\t')) : (begin += 1) {}

        var end = begin;
        while (end < tail.len and std.ascii.isDigit(tail[end])) : (end += 1) {}

        if (end == begin) {
            @panic("failed to parse nginx_version from submodules/nginx/src/core/nginx.h");
        }

        return std.fmt.parseInt(u32, tail[begin..end], 10) catch
            @panic("invalid nginx_version in submodules/nginx/src/core/nginx.h");
    }

    @panic("failed to locate nginx_version in submodules/nginx/src/core/nginx.h");
}

pub fn append(files: *ArrayList([]const u8), src: []const []const u8) !void {
    for (src) |f| {
        try files.append(f);
    }
}

pub fn list(b: *std.Build, d: []const u8, ii: usize, mem: []u8, files: *ArrayList([]const u8)) !usize {
    // Directory entries determine the serialized C source list in Zig 0.17.
    b.dependOnDirectoryContents(b.path(d));
    const io = b.graph.io;
    var dir = Io.Dir.cwd().openDir(io, d, .{ .iterate = true }) catch {
        return ii;
    };
    defer dir.close(io);

    var it = dir.iterate();
    var i = ii;
    out: while (true) {
        const e = try it.next(io);
        if (e) |entry| {
            if (entry.kind != .file and entry.kind != .directory) {
                continue;
            }
            if (entry.kind == .file and entry.name[entry.name.len - 1] != 'c') {
                continue;
            }
            for (EXCLUDES) |ex| {
                if (std.mem.eql(u8, entry.name, ex)) {
                    continue :out;
                }
            }

            const len = d.len + entry.name.len + 1;
            if (i + len > mem.len) {
                return OOM;
            } else {
                @memcpy(mem[i .. i + d.len], d);
                mem[i + d.len] = '/';
                @memcpy(mem[i + d.len + 1 .. i + d.len + 1 + entry.name.len], entry.name);
            }

            if (entry.kind == .file) {
                try files.append(mem[i .. i + len]);
                i += len;
            }
            if (entry.kind == .directory) {
                i = try list(b, mem[i .. i + len], i + len, mem, files);
            }
        } else {
            break;
        }
    }
    return i;
}
