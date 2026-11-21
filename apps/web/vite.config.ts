import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Vite de la UI (plan §11).
 *
 * El proxy `/api` evita el CORS: el navegador solo habla con el servidor de Vite y
 * este reenvía a la API. El bearer viaja en la cabecera, nunca en la URL.
 *
 * En local, el proxy **inyecta** el bearer del `.env` de la raíz si la petición no
 * trae uno: así el token del servicio no llega al bundle del navegador. Si la UI se
 * apunta a una API remota, la persona escribe su token y el proxy lo deja pasar.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");
  const localToken = env.BEACON_TOKEN ?? process.env.BEACON_TOKEN;
  const apiUrl =
    env.BEACON_API_URL ?? process.env.BEACON_API_URL ?? "http://127.0.0.1:3000";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (localToken && !proxyReq.getHeader("authorization")) {
                proxyReq.setHeader("authorization", `Bearer ${localToken}`);
              }
            });
          },
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
    test: {
      environment: "jsdom",
      globals: true,
    },
  };
});
