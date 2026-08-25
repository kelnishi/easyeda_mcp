import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import ignore from "ignore";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultExtensionRoot = path.join(repoRoot, "extension");
const defaultDistRoot = path.join(repoRoot, "build", "dist");

/**
 * The archive must carry the code the manifest claims.
 *
 * `npm run build` compiles the server; the extension bundle has a script of its
 * own, and skipping it leaves the previous dist/index.js in place. Three
 * releases shipped that way -- a manifest saying 0.4.1 wrapped around code
 * saying 0.3.5 -- and every reinstall was a silent no-op, which read as the
 * editor refusing to load the extension rather than as a packaging bug.
 */
export function assertBundleMatchesManifest(extensionRoot, manifest) {
  const bundle = path.join(extensionRoot, "dist", "index.js");
  if (!fs.existsSync(bundle)) {
    throw new Error(`No built bundle at ${bundle}. Run \`npm run build:extension\` first.`);
  }
  const declared = /EXTENSION_VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(bundle, "utf8"));
  if (declared && declared[1] !== manifest.version) {
    throw new Error(
      `Refusing to package a stale bundle: dist/index.js is ${declared[1]} but ` +
      `extension.json is ${manifest.version}. Run \`npm run build:extension\`.`
    );
  }
}

export async function packageExtension(options = {}) {
  const extensionRoot = options.extensionRoot ?? defaultExtensionRoot;
  const distRoot = options.distRoot ?? defaultDistRoot;
  const manifestPath = path.join(extensionRoot, "extension.json");
  const ignorePath = path.join(extensionRoot, ".edaignore");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  validateManifest(manifest);
  assertBundleMatchesManifest(extensionRoot, manifest);

  const ignoreRules = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8").split(/\r?\n/) : [];
  const matcher = ignore().add(ignoreRules);
  const zip = new JSZip();

  for (const file of walk(extensionRoot)) {
    const rel = path.relative(extensionRoot, file).replace(/\\/g, "/");
    if (matcher.ignores(rel)) {
      continue;
    }
    zip.file(rel, fs.readFileSync(file));
  }

  fs.mkdirSync(distRoot, { recursive: true });
  const outFile = path.join(distRoot, `${manifest.name}_v${manifest.version}.eext`);
  const compatFile = path.join(distRoot, "easyeda_mcp_bridge.eext");
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    streamFiles: true
  });
  fs.writeFileSync(outFile, buffer);
  fs.writeFileSync(compatFile, buffer);

  return {
    outFile,
    compatFile,
    manifest,
    buffer
  };
}

export function validateManifest(manifest) {
  if (!/^[a-z0-9-]{5,30}$/.test(manifest.name)) {
    throw new Error("extension.json name must be 5-30 chars of lowercase letters, numbers, or hyphen.");
  }
  if (!/^[a-z0-9]{32}$/.test(manifest.uuid)) {
    throw new Error("extension.json uuid must be exactly 32 lowercase letters or numbers.");
  }
  if (!manifest.name || !manifest.version || !manifest.entry) {
    throw new Error('extension.json must include "name", "version", and "entry".');
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await packageExtension();
  console.log(`Created ${result.outFile}`);
  console.log(`Created ${result.compatFile}`);
}
