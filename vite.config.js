import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  root: ".",
  plugins: [glsl()],
  server: {
    open: true,
  },
});
