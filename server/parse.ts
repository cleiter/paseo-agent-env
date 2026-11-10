function parseRecords(records: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const record of records) {
    if (record.length === 0) continue;
    const separator = record.indexOf("=");
    // Whitespace in a name means a log line that happens to contain "=".
    if (separator <= 0 || /\s/.test(record.slice(0, separator))) {
      // Never quote the record: it may be part of a secret. A command that logs to stdout is
      // misconfigured, not partially usable.
      throw new Error("expected KEY=VALUE records on stdout; log to stderr instead");
    }
    result[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return result;
}

/**
 * Parse the environment a command printed to stdout. Three encodings, detected in order:
 *
 *   1. a JSON object            (`mise env --json`, any script)
 *   2. NUL-delimited KEY=VALUE  (`direnv exec . env -0`), the only KEY=VALUE form that can
 *                                carry multi-line values such as a PEM key
 *   3. newline-delimited KEY=VALUE
 *
 * A JSON `null` value unsets the variable, matching `direnv export json`.
 */
export function parseEnvOutput(stdout: string): Record<string, string | null> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("command printed no environment to stdout");
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("stdout starts with { but is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("environment JSON is not an object");
    }
    const result: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      // A process environment cannot carry these, and spawning with one fails with an error
      // that quotes the value.
      if (key.length === 0 || key.includes("=") || key.includes("\0")) {
        throw new Error("environment JSON has an invalid variable name");
      }
      if (typeof value === "string" && value.includes("\0")) {
        throw new Error(`environment JSON value for ${key} contains a NUL byte`);
      }
      if (typeof value === "string" || value === null) result[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value);
      else throw new Error(`environment JSON value for ${key} is not a string`);
    }
    return result;
  }

  // Split the raw output, not the trimmed copy: trailing whitespace can belong to the last
  // value, and trimming it would corrupt a secret rather than fail.
  if (stdout.includes("\0")) return parseRecords(stdout.split("\0"));
  return parseRecords(stdout.split(/\r?\n/));
}
