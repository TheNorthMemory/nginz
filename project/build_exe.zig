const std = @import("std");

pub fn build_exe(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.lang.Optimize,
) !*std.Build.Step.Compile {
    const nginz = b.addExecutable(.{
        .name = "nginz",
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .root_source_file = b.path("src/nginz.zig"),
        }),
    });

    return nginz;
}
