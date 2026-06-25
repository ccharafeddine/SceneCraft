import { defineConfig } from "vitest/config";

// Standalone Vitest config (does NOT load vite.config.ts / the Solid plugin).
// Current tests are pure logic (routing), so a plain node environment is right
// and avoids pulling in jsdom. Add a jsdom project here later if/when we test
// Solid components.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
