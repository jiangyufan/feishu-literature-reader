import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        host: "0.0.0.0",
    },
    build: {
        // 每次发版清空 dist，避免 emptyOutDir:false 残留旧 hash 资源（旧 index.*.js / RenderMarkDown-*.js）
        // 被 deploy_api.py 整树替换一并上传到 gh-pages，造成孤儿文件累积。
        emptyOutDir: true,
        rollupOptions: {
            external: ["#minpath", "#minproc", "#minurl"],
        },
    },
});
