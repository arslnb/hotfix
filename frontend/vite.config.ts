import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  plugins: [tailwindcss(), solid()],
  server: {
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
        secure: false,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
