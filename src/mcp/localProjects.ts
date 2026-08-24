import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * EasyEDA Pro's own file-enumeration APIs (sys_FileSystem.getProjectsPaths,
 * listFilesOfFileSystem) hang when called from the extension context, and the
 * document APIs go dark whenever no project is loaded -- which is exactly the
 * state you need enumeration in. The server has filesystem access of its own, so
 * it reads the editor's configuration and project files directly instead.
 */

export type LocalProject = {
  path: string;
  name: string;
  uuid?: string;
  updatedAt?: string;
  /** Set when the project file could not be read; the path is still reported. */
  error?: string;
};

const CONFIG_RELATIVE = join("Documents", "EasyEDA-Pro", "config.json");

export function defaultConfigPath(): string {
  return join(homedir(), CONFIG_RELATIVE);
}

/**
 * APP_PROJECT_DIR is the same list the editor's Recent Projects tab is built
 * from, so a project visible there is discoverable here.
 */
export async function readProjectDirs(configPath: string): Promise<string[]> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as { APP_PROJECT_DIR?: unknown };
  const dirs = config.APP_PROJECT_DIR;
  return Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : [];
}

export async function findProjectFiles(dirs: string[], maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || seen.has(dir)) {
      return;
    }
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          await walk(full, depth + 1);
        }
      } else if (entry.name.endsWith(".eprj2")) {
        found.push(full);
      }
    }
  };

  for (const dir of dirs) {
    await walk(dir, 0);
  }
  return found.sort();
}

/**
 * A .eprj2 is SQLite, and its `projects` table carries the uuid that
 * dmt_Project.openProject expects -- the value that otherwise has to be
 * recovered from a tab id or guessed.
 */
export async function readProjectFile(path: string): Promise<LocalProject> {
  const name = path.split("/").pop()?.replace(/\.eprj2$/, "") ?? path;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("select uuid, name, updated_at from projects").all() as Array<{
        uuid?: string;
        name?: string;
        updated_at?: string;
      }>;
      const row = rows[0];
      return {
        path,
        name: row?.name ?? name,
        uuid: row?.uuid,
        updatedAt: row?.updated_at
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { path, name, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listLocalProjects(configPath: string, maxDepth = 3): Promise<LocalProject[]> {
  const dirs = await readProjectDirs(configPath);
  const files = await findProjectFiles(dirs, maxDepth);
  const projects = await Promise.all(files.map((file) => readProjectFile(file)));

  // Most recently touched first: the project someone is working on is the one
  // they are almost always asking for.
  const withTimes = await Promise.all(
    projects.map(async (project) => {
      try {
        const info = await stat(project.path);
        return { project, mtime: info.mtimeMs };
      } catch {
        return { project, mtime: 0 };
      }
    })
  );
  return withTimes.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.project);
}
