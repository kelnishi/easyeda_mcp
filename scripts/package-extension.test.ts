import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { packageExtension, validateManifest } from "./package-extension.mjs";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "easyeda-mcp-package-test-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("package-extension script", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("packages the extension and respects .edaignore", async () => {
    const root = makeTempDir();
    tempDirs.push(root);

    const extensionRoot = path.join(root, "extension");
    const distRoot = path.join(root, "dist");
    writeJson(path.join(extensionRoot, "extension.json"), {
      name: "easyeda-mcp-bridge",
      uuid: "easyedamcpbridge202605240001abcd",
      version: "0.1.2",
      entry: "./dist/index"
    });
    fs.writeFileSync(path.join(extensionRoot, ".edaignore"), "secret.txt\n");
    fs.mkdirSync(path.join(extensionRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, "dist", "index.js"), "console.log('bridge');\n");
    fs.writeFileSync(path.join(extensionRoot, "README.md"), "# bridge\n");
    fs.writeFileSync(path.join(extensionRoot, "secret.txt"), "do not ship\n");

    const result = await packageExtension({ extensionRoot, distRoot });
    const archive = await JSZip.loadAsync(result.buffer);

    expect(fs.existsSync(result.outFile)).toBe(true);
    expect(fs.existsSync(result.compatFile)).toBe(true);
    expect(Object.keys(archive.files)).toContain("extension.json");
    expect(Object.keys(archive.files)).toContain("dist/index.js");
    expect(Object.keys(archive.files)).not.toContain("secret.txt");
  });

  it("refuses to ship a bundle built from a different version than the manifest", async () => {
    // Three releases went out packaged around stale JavaScript. `npm run build`
    // compiles the server; the extension bundle has its own script, and skipping
    // it leaves the previous dist/index.js in place. The manifest said 0.4.1 and
    // the code in the archive said 0.3.5, so every reinstall was a no-op and the
    // failure looked like the editor refusing to load the new extension.
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eext-stale-"));
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eext-stale-dist-"));
    writeJson(path.join(extensionRoot, "extension.json"), {
      name: "easyeda-mcp-bridge",
      uuid: "easyedamcpbridge202605240001abcd",
      version: "0.4.1",
      entry: "./dist/index"
    });
    fs.mkdirSync(path.join(extensionRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(extensionRoot, "dist", "index.js"),
      'const EXTENSION_VERSION = "0.3.5";\n'
    );

    await expect(packageExtension({ extensionRoot, distRoot })).rejects.toThrow(
      /0\.3\.5.*0\.4\.1|stale/i
    );
  });

  it("rejects invalid manifest names", () => {
    expect(() =>
      validateManifest({
        name: "BadName",
        uuid: "easyedamcpbridge202605240001abcd",
        version: "0.1.2",
        entry: "./dist/index"
      })
    ).toThrow("extension.json name must be 5-30 chars");
  });
});
