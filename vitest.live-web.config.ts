import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
    test: {
        env: loadEnv(mode, process.cwd(), ''),
        include: ['tests/live-web/**/*.test.ts'],
        testTimeout: 180000,
        hookTimeout: 60000,
        poolOptions: {
            threads: {
                singleThread: true,
            },
        },
    },
}))
