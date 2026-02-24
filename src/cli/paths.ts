import { tmpdir } from 'os'
import { join } from 'path'

function prefix(namespace: string): string {
    return `opensteer-${namespace}`
}

export function getSocketPath(namespace: string): string {
    return join(tmpdir(), `${prefix(namespace)}.sock`)
}

export function getPidPath(namespace: string): string {
    return join(tmpdir(), `${prefix(namespace)}.pid`)
}
