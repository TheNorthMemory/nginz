const std = @import("std");
const Build = std.Build;
const Step = std.Build.Step;

/// Apply the nginz patch to the nginx C entry point.
///
/// Let make track the source, patch, and configured headers. Its recipe only
/// replaces nginz.c when the patched contents change, preserving cached builds
/// without ignoring updated inputs or missing configuration files.
/// Rewriting byte-identical C changes its mtime and triggers a roughly 5-second
/// relink under Zig 0.17, which can exceed Bun's beforeAll hook timeout. Keep
/// the Make recipes' compare-before-replace behavior when changing this step.
pub fn patchStep(b: *Build, docker: bool) *Step {
    const makefile = if (docker) "project/nginz.docker.makefile" else "project/nginz.makefile";
    const run = b.addSystemCommand(&.{ "make", "-f", makefile });

    // Preserve the historical `zig build patch` top-level step name.
    const named = b.step("patch", "patch nginz");
    named.dependOn(&run.step);

    return &run.step;
}
