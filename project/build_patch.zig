const std = @import("std");
const Build = std.Build;
const Step = std.Build.Step;

pub fn patchStep(b: *Build, docker: bool) *Step {
    const makefile = if (docker) "project/nginz.docker.makefile" else "project/nginz.makefile";
    const run = b.addSystemCommand(&[_][]const u8{ "make", "-f", makefile });
    run.stdio = .inherit;

    // Preserve the historical `zig build patch` top-level step name.
    const named = b.step("patch", "patch nginz");
    named.dependOn(&run.step);

    return &run.step;
}
