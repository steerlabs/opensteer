import fs from 'fs'
import http from 'http'
import path from 'path'

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
}

export interface TestAppServer {
    url: string
    close: () => Promise<void>
}

export async function startTestApp(distDir: string): Promise<TestAppServer> {
    const absoluteDist = path.resolve(distDir)

    const server = http.createServer((req, res) => {
        const requestUrl = req.url ?? '/'
        const pathname = new URL(requestUrl, 'http://localhost').pathname
        const normalizedPath =
            pathname === '/' ? '/index.html' : decodeURIComponent(pathname)

        const safePath = path.normalize(normalizedPath).replace(/^\.+/, '')
        const filePath = path.join(absoluteDist, safePath)

        if (
            filePath.startsWith(absoluteDist) &&
            fs.existsSync(filePath) &&
            fs.statSync(filePath).isFile()
        ) {
            const ext = path.extname(filePath).toLowerCase()
            res.writeHead(200, {
                'Content-Type':
                    CONTENT_TYPES[ext] ?? 'application/octet-stream',
            })
            res.end(fs.readFileSync(filePath))
            return
        }

        const spaIndex = path.join(absoluteDist, 'index.html')
        if (!fs.existsSync(spaIndex)) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Missing test app index.html')
            return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(fs.readFileSync(spaIndex))
    })

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve test app server address')
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error)
                        return
                    }
                    resolve()
                })
            }),
    }
}
