import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        if (
          warning.code === 'INVALID_ANNOTATION' &&
          warning.message?.includes('@vueuse/core')
        ) {
          return;
        }

        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) {
            return undefined;
          }

          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/@vue/')
          ) {
            return 'vendor-vue';
          }

          if (id.includes('/node_modules/element-plus/es/components/')) {
            const component = id
              .split('/node_modules/element-plus/es/components/')[1]
              ?.split('/')[0];
            return component ? `element-${component}` : 'element-components';
          }

          if (id.includes('/node_modules/@element-plus/icons-vue/')) {
            return 'element-icons';
          }

          if (id.includes('/node_modules/@popperjs/')) {
            return 'element-popper';
          }

          if (id.includes('/node_modules/element-plus/')) {
            return 'element-core';
          }

          if (id.includes('/node_modules/@vueuse/')) {
            return 'vendor-vueuse';
          }

          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
