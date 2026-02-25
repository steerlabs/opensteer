import type {
    RemoteErrorCode,
    RemoteSelectorCacheImportRequest,
    RemoteSelectorCacheImportResponse,
    RemoteSessionCreateRequest,
    RemoteSessionCreateResponse,
} from './contracts.js'
import { OpensteerRemoteError } from './errors.js'
import type { OpensteerAuthScheme } from '../types.js'

interface RemoteHttpErrorBody {
    error?: string
    code?: string
    details?: Record<string, unknown>
}

const CACHE_IMPORT_BATCH_SIZE = 200

export class RemoteSessionClient {
    private readonly baseUrl: string
    private readonly key: string
    private readonly authScheme: OpensteerAuthScheme

    constructor(
        baseUrl: string,
        key: string,
        authScheme: OpensteerAuthScheme = 'api-key'
    ) {
        this.baseUrl = normalizeBaseUrl(baseUrl)
        this.key = key
        this.authScheme = authScheme
    }

    async create(
        request: RemoteSessionCreateRequest
    ): Promise<RemoteSessionCreateResponse> {
        const response = await fetch(`${this.baseUrl}/sessions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...this.authHeaders(),
            },
            body: JSON.stringify(request),
        })

        if (!response.ok) {
            throw await parseHttpError(response)
        }

        return (await response.json()) as RemoteSessionCreateResponse
    }

    async close(sessionId: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: {
                ...this.authHeaders(),
            },
        })

        if (response.status === 204) {
            return
        }

        if (!response.ok) {
            throw await parseHttpError(response)
        }
    }

    async importSelectorCache(
        request: RemoteSelectorCacheImportRequest
    ): Promise<RemoteSelectorCacheImportResponse> {
        if (!request.entries.length) {
            return zeroImportResponse()
        }

        let totals = zeroImportResponse()

        for (
            let offset = 0;
            offset < request.entries.length;
            offset += CACHE_IMPORT_BATCH_SIZE
        ) {
            const batch = request.entries.slice(
                offset,
                offset + CACHE_IMPORT_BATCH_SIZE
            )
            const response = await this.importSelectorCacheBatch(batch)
            totals = mergeImportResponse(totals, response)
        }

        return totals
    }

    private async importSelectorCacheBatch(
        entries: RemoteSelectorCacheImportRequest['entries']
    ): Promise<RemoteSelectorCacheImportResponse> {
        const response = await fetch(`${this.baseUrl}/selector-cache/import`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...this.authHeaders(),
            },
            body: JSON.stringify({ entries }),
        })

        if (!response.ok) {
            throw await parseHttpError(response)
        }

        return (await response.json()) as RemoteSelectorCacheImportResponse
    }

    private authHeaders(): Record<string, string> {
        if (this.authScheme === 'bearer') {
            return {
                authorization: `Bearer ${this.key}`,
            }
        }

        return {
            'x-api-key': this.key,
        }
    }
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '')
}

function zeroImportResponse(): RemoteSelectorCacheImportResponse {
    return {
        imported: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
    }
}

function mergeImportResponse(
    first: RemoteSelectorCacheImportResponse,
    second: RemoteSelectorCacheImportResponse
): RemoteSelectorCacheImportResponse {
    return {
        imported: first.imported + second.imported,
        inserted: first.inserted + second.inserted,
        updated: first.updated + second.updated,
        skipped: first.skipped + second.skipped,
    }
}

async function parseHttpError(
    response: Response
): Promise<OpensteerRemoteError> {
    let body: RemoteHttpErrorBody | null = null

    try {
        body = (await response.json()) as RemoteHttpErrorBody
    } catch {
        body = null
    }

    const code =
        typeof body?.code === 'string'
            ? toRemoteErrorCode(body.code)
            : ('REMOTE_TRANSPORT_ERROR' as const)
    const message =
        typeof body?.error === 'string'
            ? body.error
            : `Remote request failed with status ${response.status}.`

    return new OpensteerRemoteError(code, message, response.status, body?.details)
}

function toRemoteErrorCode(
    code: string
): RemoteErrorCode | 'REMOTE_TRANSPORT_ERROR' {
    if (
        code === 'REMOTE_AUTH_FAILED' ||
        code === 'REMOTE_SESSION_NOT_FOUND' ||
        code === 'REMOTE_SESSION_CLOSED' ||
        code === 'REMOTE_UNSUPPORTED_METHOD' ||
        code === 'REMOTE_INVALID_REQUEST' ||
        code === 'REMOTE_MODEL_NOT_ALLOWED' ||
        code === 'REMOTE_ACTION_FAILED' ||
        code === 'REMOTE_INTERNAL' ||
        code === 'REMOTE_CAPACITY_EXHAUSTED' ||
        code === 'REMOTE_RUNTIME_UNAVAILABLE' ||
        code === 'REMOTE_RUNTIME_MISMATCH' ||
        code === 'REMOTE_SESSION_STALE' ||
        code === 'REMOTE_CONTROL_PLANE_ERROR'
    ) {
        return code
    }

    return 'REMOTE_TRANSPORT_ERROR'
}
