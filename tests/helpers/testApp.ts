import fs from 'fs'
import path from 'path'

const URL_FILE = path.resolve(process.cwd(), 'tests/.test-app-url')

export function getTestAppUrl(): string {
    if (process.env.TEST_APP_URL && process.env.TEST_APP_URL.length > 0) {
        return process.env.TEST_APP_URL
    }

    if (!fs.existsSync(URL_FILE)) {
        throw new Error('TEST_APP_URL is not available. Did globalSetup run?')
    }

    const url = fs.readFileSync(URL_FILE, 'utf8').trim()
    if (!url) {
        throw new Error('tests/.test-app-url is empty')
    }

    return url
}

export function getTestAppRoute(pathname: string): string {
    const base = getTestAppUrl().replace(/\/$/, '')
    const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
    return `${base}${normalizedPath}`
}
