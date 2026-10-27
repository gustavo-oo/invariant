import { existsSync } from "node:fs";
import path from "node:path";
import { configDefaults, defineConfig, type Plugin } from "vitest/config";

const tsFromJs: Plugin = {
  name: "invariant-ts-from-js",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !source.startsWith("./") && !source.startsWith("../")) return;
    if (!source.endsWith(".js")) return;
    const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + ".ts");
    if (existsSync(candidate)) return candidate;
  },
};

export default defineConfig({
  plugins: [tsFromJs],
  // Fixtures are corpus data that merely looks like test files; keep the
  // default excludes (node_modules, dist, ...) and add the fixture tree.
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
    testTimeout: 30_000,
  },
});
