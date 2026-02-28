import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startTestApp } from './fixtures/server.js'

const TEST_APP_ROOT = path.resolve(process.cwd(), 'tests/test-app')
const TEST_APP_DIST = path.join(TEST_APP_ROOT, 'dist')
const TEST_APP_NODE_MODULES = path.join(TEST_APP_ROOT, 'node_modules')
const URL_FILE = path.resolve(process.cwd(), 'tests/.test-app-url')

type PackageManager = 'bun' | 'npm' | 'pnpm'

function resolvePackageManager(): PackageManager {
    const manager = process.env.npm_config_user_agent?.split('/')[0]
    if (manager === 'bun' || manager === 'npm' || manager === 'pnpm') {
        return manager
    }

    throw new Error(
        'Unable to determine package manager for test-app setup. Run tests via bun, npm, or pnpm scripts.',
    )
}

function installTestAppDependencies(manager: PackageManager): void {
    const args =
        manager === 'npm'
            ? ['install', '--no-audit', '--no-fund']
            : manager === 'pnpm'
              ? ['install', '--frozen-lockfile']
              : ['install']

    execFileSync(manager, args, { cwd: TEST_APP_ROOT, stdio: 'inherit' })
}

function buildTestApp(manager: PackageManager): void {
    execFileSync(manager, ['run', 'build'], {
        cwd: TEST_APP_ROOT,
        stdio: 'inherit',
    })
}

export default async function setup() {
    const manager = resolvePackageManager()

    if (!fs.existsSync(TEST_APP_NODE_MODULES)) {
        installTestAppDependencies(manager)
    }

    buildTestApp(manager)

    const server = await startTestApp(TEST_APP_DIST)
    process.env.TEST_APP_URL = server.url
    fs.writeFileSync(URL_FILE, server.url, 'utf8')

    return async () => {
        await server.close()
        if (fs.existsSync(URL_FILE)) {
            fs.rmSync(URL_FILE)
        }
    }
}
