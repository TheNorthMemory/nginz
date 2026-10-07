const std = @import("std");
const common = @import("build_common.zig");
const ArrayList = std.array_list.Managed;

const NJS_C_FLAGS = [_][]const u8{
    "-fvisibility=hidden",
    "-Wall",
    "-Werror",
    "-Wextra",
    "-Wno-unused-parameter",
    "-Wno-cast-function-type-mismatch",
    // nginx supplies typed pool callbacks to njs's generic chain/hash APIs.
    "-fno-sanitize=function",
    // njs casts a nonnumeric key's NaN index before testing whether it is
    // representable (njs_atom_atomize_key). Keep ReleaseSafe, but exclude
    // this C conversion check for the upstream JS engine.
    "-fno-sanitize=float-cast-overflow",
    "-Wwrite-strings",
    "-Wmissing-prototypes",
    "-fexcess-precision=standard",
    "-Wpointer-arith",
};

const NJS_INCLUDE_PATH = [_][]const u8{
    "submodules/quickjs",
    "submodules/njs/src",
    "submodules/njs/build",
    "submodules/njs/external",
    //"submodules/nginx/src/stream",
};

const modules_files = .{
    // nginx registers crypto/XML/zlib through its engine addons. The njs
    // CLI configure output registers them too, which breaks njs VM startup.
    "project/njs_modules.c",
    "project/qjs_modules.c",
};

const http_module_files = .{
    "submodules/njs/nginx/ngx_js.c",
    "submodules/njs/nginx/ngx_js_http.c",
    "submodules/njs/nginx/ngx_js_form.c",
    "submodules/njs/nginx/ngx_js_fetch.c",
    "submodules/njs/nginx/ngx_js_regex.c",
    "submodules/njs/nginx/ngx_qjs_fetch.c",
    "submodules/njs/nginx/ngx_http_js_module.c",
    "submodules/njs/nginx/ngx_js_shared_dict.c",
    //"submodules/njs/nginx/ngx_stream_js_module.c",
};

pub fn build_njs(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.lang.Optimize,
    quickjs: *std.Build.Step.Compile,
) !*std.Build.Step.Compile {
    const njs = b.addLibrary(.{
        .name = "njs",
        .root_module = b.createModule(.{
            .pic = true,
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    var files = ArrayList([]const u8).init(b.allocator);
    defer files.deinit();
    const n = try common.list(b, "./submodules/njs/src", 0, &common.BUILD_BUFFER, &files);
    _ = try common.list(b, "./submodules/njs/external", n, &common.BUILD_BUFFER, &files);

    try common.append(&files, &modules_files);

    for (NJS_INCLUDE_PATH) |p| {
        njs.root_module.addIncludePath(b.path(p));
    }
    const libxml2 = std.Build.LazyPath{ .cwd_relative = "/usr/include/libxml2" };
    njs.root_module.addSystemIncludePath(libxml2);
    njs.root_module.addCSourceFiles(.{
        .files = files.items[0..],
        .flags = &NJS_C_FLAGS,
    });

    njs.step.dependOn(&quickjs.step);
    njs.root_module.linkLibrary(quickjs);

    // b.installArtifact(njs);

    const http_njs = b.addObject(.{
        .name = "ngx_http_js_module",
        .root_module = b.createModule(.{
            .pic = true,
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    http_njs.step.dependOn(&njs.step);
    http_njs.root_module.linkLibrary(njs);
    http_njs.root_module.linkLibrary(quickjs);
    http_njs.root_module.addIncludePath(b.path("submodules/njs/nginx"));
    for (common.NGX_INCLUDE_PATH) |p| {
        http_njs.root_module.addIncludePath(b.path(p));
    }
    for (NJS_INCLUDE_PATH) |p| {
        http_njs.root_module.addIncludePath(b.path(p));
    }

    http_njs.root_module.addCSourceFiles(.{
        .files = &http_module_files,
        // CLI configure names this feature LIBXML2; nginx uses XML for addons.
        .flags = &(common.C_FLAGS ++ .{"-DNJS_HAVE_XML=1"}),
    });
    const install_object = b.addInstallFile(http_njs.getEmittedBin(), "ngx_http_js_module.o");
    b.getInstallStep().dependOn(&install_object.step);

    return http_njs;
}
