import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_SECRET_FILE_BYTES = 16 * 1024;

function readSecretFile(fileVariable: string, path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error("not a regular file");
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw new Error("insecure file permissions");
    }
    if (metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new Error("secret file is too large");
    }

    const value = readFileSync(descriptor, "utf8").replace(/[\r\n]+$/, "");
    if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
      throw new Error("secret file must contain one line");
    }
    return value.trim() ? value : undefined;
  } catch {
    throw new Error(`${fileVariable} could not be read securely`);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function readOptionalSecret(
  name: string,
  environment: Environment = process.env,
): string | undefined {
  const directValue = environment[name]?.trim();
  const fileVariable = `${name}_FILE`;
  const secretFile = environment[fileVariable]?.trim();

  if (directValue && secretFile) {
    throw new Error(`${name} and ${fileVariable} cannot both be configured`);
  }
  if (!secretFile) {
    return directValue || undefined;
  }

  return readSecretFile(fileVariable, secretFile);
}
