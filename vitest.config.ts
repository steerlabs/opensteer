import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
    test: {
        env: loadEnv(mode, process.cwd(), ''),
        include: ['tests/**/*.test.ts'],
        exclude: ['tests/live-web/**/*.test.ts'],
        globalSetup: ['./tests/globalSetup.ts'],
        testTimeout: 30000,
        hookTimeout: 30000,
        poolOptions: {
            threads: {
                singleThread: true,
            },
        },
    },
}))
