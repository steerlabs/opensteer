import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

function getRuntimeDir(): string {
    const dir = join(homedir(), '.oversteer')
    mkdirSync(dir, { recursive: true })
    return dir
}

export function getSocketPath(): string {
    return join(getRuntimeDir(), 'oversteer.sock')
}

export function getPidPath(): string {
    return join(getRuntimeDir(), 'oversteer.pid')
}
