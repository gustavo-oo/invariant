import { defineConfig } from "vitest/config";

// A real Vue 3 + Fastify repo uses `jsdom` for client and `node` for server.
// The fixture keeps both on `node` so it needs no extra browser dependency; the
// adapter composition is what it exercises.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "client", environment: "node", include: ["client/**/*.test.ts"] } },
      { test: { name: "server", environment: "node", include: ["server/**/*.test.ts"] } },
    ],
  },
});
