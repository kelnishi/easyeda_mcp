import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectFiles, readProjectDirs, readProjectFile, listLocalProjects } from "./localProjects.js";

async function makeProjectFile(path: string, uuid: string, name: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("create table projects (uuid text, name text, updated_at text)");
  db.prepare("insert into projects values (?, ?, ?)").run(uuid, name, "2026-08-24 16:12:39");
  db.close();
}

describe("readProjectDirs", () => {
  it("reads the directories the editor scans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eda-cfg-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ APP_PROJECT_DIR: ["/a", "/b", 42] }));
    expect(await readProjectDirs(configPath)).toEqual(["/a", "/b"]);
  });

  it("tolerates a config with no project directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eda-cfg-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ type: "HALF_OFFLINE" }));
    expect(await readProjectDirs(configPath)).toEqual([]);
  });
});

describe("findProjectFiles", () => {
  it("finds project files nested under a scanned directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eda-proj-"));
    await mkdir(join(root, "kamen_driver"), { recursive: true });
    await writeFile(join(root, "kamen_driver", "Kamen Driver.eprj2"), "");
    await writeFile(join(root, "notes.md"), "");

    const found = await findProjectFiles([root]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Kamen Driver.eprj2");
  });

  it("ignores a directory that does not exist rather than throwing", async () => {
    expect(await findProjectFiles(["/no/such/place"])).toEqual([]);
  });
});

describe("readProjectFile", () => {
  it("recovers the uuid openProject expects", async () => {
    // This uuid is otherwise only obtainable from a tab id, or by guessing.
    const root = await mkdtemp(join(tmpdir(), "eda-proj-"));
    const path = join(root, "Kamen Driver.eprj2");
    await makeProjectFile(path, "1850e95d", "Kamen Driver");

    const project = await readProjectFile(path);
    expect(project).toMatchObject({ uuid: "1850e95d", name: "Kamen Driver" });
    expect(project.error).toBeUndefined();
  });

  it("reports an unreadable project without losing its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "eda-proj-"));
    const path = join(root, "Broken.eprj2");
    await writeFile(path, "not a database");

    const project = await readProjectFile(path);
    expect(project.path).toBe(path);
    expect(project.name).toBe("Broken");
    expect(project.error).toBeDefined();
  });
});

describe("listLocalProjects", () => {
  it("resolves config to projects with their uuids", async () => {
    const root = await mkdtemp(join(tmpdir(), "eda-proj-"));
    await mkdir(join(root, "nested"), { recursive: true });
    await makeProjectFile(join(root, "nested", "One.eprj2"), "uuid-one", "One");

    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ APP_PROJECT_DIR: [root] }));

    const projects = await listLocalProjects(configPath);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ uuid: "uuid-one", name: "One" });
  });
});
