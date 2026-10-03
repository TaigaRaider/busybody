import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    // The note-body parser is shared with the API and the test suite from
    // ../../lib, which lives outside the Vite root.
    fs: { allow: [".."] },
  },
});
