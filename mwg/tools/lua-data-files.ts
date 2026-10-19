// The Lua file provider for node: paths relative to the checkout's `data/` directory,
// read from disk (build tools and tests; the browser gets them bundled).
import fs from 'node:fs';
import path from 'node:path';
import type { LuaFileProvider } from '../src/scripting/lua-vm.ts';

export function dataFiles(dataDir: string): LuaFileProvider {
  return {
    read(file) {
      try {
        const full = path.join(dataDir, file);
        return fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
      } catch {
        return null;
      }
    },
    list(dir) {
      try {
        return fs.readdirSync(path.join(dataDir, dir), { withFileTypes: true })
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      } catch {
        return null;
      }
    },
  };
}
