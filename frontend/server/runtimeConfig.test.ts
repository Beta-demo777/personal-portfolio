import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readOptionalSecret } from "./runtimeConfig";

test("reads an optional secret from the environment", () => {
  assert.equal(readOptionalSecret("TOKEN", { TOKEN: "  direct-value  " }), "direct-value");
  assert.equal(readOptionalSecret("TOKEN", {}), undefined);
});

test("reads a secret from a file without retaining its trailing newline", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portfolio-secret-test-"));
  try {
    const secretFile = path.join(directory, "token");
    writeFileSync(secretFile, "file-value\n", { mode: 0o600 });
    assert.equal(
      readOptionalSecret("TOKEN", { TOKEN_FILE: secretFile }),
      "file-value",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects ambiguous secret sources without exposing either value", () => {
  const secretValue = "do-not-print-this";
  const secretFile = "/private/do-not-print-this-path";
  assert.throws(
    () => readOptionalSecret("TOKEN", { TOKEN: secretValue, TOKEN_FILE: secretFile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "TOKEN and TOKEN_FILE cannot both be configured");
      assert.equal(error.message.includes(secretValue), false);
      assert.equal(error.message.includes(secretFile), false);
      return true;
    },
  );
});

test("treats an empty optional secret file as unconfigured", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portfolio-secret-test-"));
  try {
    const emptyFile = path.join(directory, "empty-token");
    writeFileSync(emptyFile, "\n", { mode: 0o600 });
    assert.equal(readOptionalSecret("TOKEN", { TOKEN_FILE: emptyFile }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an unreadable secret file without exposing its path", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portfolio-secret-test-"));
  try {
    const missingFile = path.join(directory, "missing-token");
    assert.throws(
      () => readOptionalSecret("TOKEN", { TOKEN_FILE: missingFile }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(missingFile), false);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects symlinked, insecure, oversized, and multiline secret files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portfolio-secret-test-"));
  try {
    const target = path.join(directory, "target");
    const symlink = path.join(directory, "symlink");
    const insecure = path.join(directory, "insecure");
    const oversized = path.join(directory, "oversized");
    const multiline = path.join(directory, "multiline");
    writeFileSync(target, "target-secret", { mode: 0o600 });
    symlinkSync(target, symlink);
    writeFileSync(insecure, "insecure-secret", { mode: 0o600 });
    chmodSync(insecure, 0o622);
    writeFileSync(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    writeFileSync(multiline, "first\nsecond\n", { mode: 0o600 });

    for (const secretFile of [symlink, insecure, oversized, multiline]) {
      assert.throws(
        () => readOptionalSecret("TOKEN", { TOKEN_FILE: secretFile }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "TOKEN_FILE could not be read securely");
          assert.equal(error.message.includes(secretFile), false);
          return true;
        },
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
