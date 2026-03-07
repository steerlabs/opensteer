import { defineConfig } from 'vitest/config'

export default defineConfig(() => ({
    test: {
        env: {
            OPENSTEER_DISABLE_DOTENV_AUTOLOAD: 'true',
        },
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
