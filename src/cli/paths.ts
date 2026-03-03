import { tmpdir } from 'os'
import { join } from 'path'

function prefix(session: string): string {
    return `opensteer-${session}`
}

export function getSocketPath(session: string): string {
    return join(tmpdir(), `${prefix(session)}.sock`)
}

export function getPidPath(session: string): string {
    return join(tmpdir(), `${prefix(session)}.pid`)
}

export function getMetadataPath(session: string): string {
    return join(tmpdir(), `${prefix(session)}.meta.json`)
}

export function getLockPath(session: string): string {
    return join(tmpdir(), `${prefix(session)}.lock`)
}
