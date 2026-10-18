import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

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
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
