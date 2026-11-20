import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
var DEV_ORIGIN = 'http://127.0.0.1:5174';
export default defineConfig({
    plugins: [react()],
    server: {
        // A preview pane or tunnel opens the dev server under its own host name; only for local development.
        allowedHosts: process.env.DRIVER_DEV_ANY_HOST ? true : ['.ngrok-free.dev'],
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:3001',
                changeOrigin: true,
                // The API accepts changes only from the driver app's own site; through the dev proxy that is this server.
                headers: { origin: DEV_ORIGIN },
                rewrite: function (path) { return path.replace(/^\/api/, ''); }
            }
        }
    }
});
