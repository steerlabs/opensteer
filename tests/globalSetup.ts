import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startTestApp } from './fixtures/server.js'

const TEST_APP_ROOT = path.resolve(process.cwd(), 'tests/test-app')
const TEST_APP_DIST = path.join(TEST_APP_ROOT, 'dist')
const URL_FILE = path.resolve(process.cwd(), 'tests/.test-app-url')

export default async function setup() {
    if (!fs.existsSync(path.join(TEST_APP_ROOT, 'node_modules'))) {
        execSync('npm install --no-fund --no-audit', {
            cwd: TEST_APP_ROOT,
            stdio: 'inherit',
        })
    }

    execSync('npm run build', {
        cwd: TEST_APP_ROOT,
        stdio: 'inherit',
    })

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
