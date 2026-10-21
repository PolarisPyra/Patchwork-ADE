import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: (id) =>
                /node_modules[\\/](@tiptap|prosemirror-|orderedmap|rope-sequence|w3c-keyname|style-mod|crelt|linkifyjs)/.test(id)
                  ? "tiptap"
                  : null,
            },
          ],
        },
      },
    },
  },
});
