import { spawnSync } from "bun";

let docker;

// Use the current user's Docker access, with the existing noninteractive sudo
// fallback used by the ACME fixtures. Never require a password prompt in tests.
export function dockerCommand() {
  if (docker) return docker;
  const failures = [];
  for (const command of [["docker"], ["sudo", "-n", "docker"]]) {
    try {
      const result = spawnSync([...command, "info", "--format", "{{.ServerVersion}}"], {
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      if (result.exitCode === 0) {
        docker = command;
        return docker;
      }
      failures.push(command.join(" ") + ": " + result.stderr.toString().trim());
    } catch (error) {
      failures.push(command.join(" ") + ": " + error.message);
    }
  }
  throw new Error("Docker is not accessible to the test user:\n" + failures.join("\n"));
}
