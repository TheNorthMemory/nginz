const std = @import("std");
const Build = std.Build;
const Step = std.Build.Step;

/// Apply the nginz patch to the nginx C entry point.
///
/// The historical `make` recipe unconditionally re-copies `nginx.c` over
/// `nginz.c` and re-applies the patch, which changes `nginz.c`'s mtime even
/// when its content is identical. Under Zig 0.17 the build runner treats that
/// metadata change as a dirty C input and relinks the whole `nginz` binary on
/// every invocation (several seconds), which is slow enough to trip the
/// integration harness build lock/hook timeout. Guard the recipe so an
/// already-patched `nginz.c` is left untouched and the compile stays cached.
pub fn patchStep(b: *Build, docker: bool) *Step {
    const makefile = if (docker) "project/nginz.docker.makefile" else "project/nginz.makefile";
    const script = b.fmt(
        "grep -qF 'main_nginx(int argc' submodules/nginx/objs/nginz.c 2>/dev/null || make -f {s}",
        .{makefile},
    );
    const run = b.addSystemCommand(&[_][]const u8{ "sh", "-c", script });

    // Preserve the historical `zig build patch` top-level step name.
    const named = b.step("patch", "patch nginz");
    named.dependOn(&run.step);

    return &run.step;
}
