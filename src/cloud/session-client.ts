import type {
    CloudErrorCode,
    CloudSelectorCacheImportRequest,
    CloudSelectorCacheImportResponse,
    CloudSessionCreateRequest,
    CloudSessionCreateResponse,
} from './contracts.js'
import { OpensteerCloudError } from './errors.js'

interface CloudHttpErrorBody {
    error?: string
    code?: string
}

const CACHE_IMPORT_BATCH_SIZE = 200

export class CloudSessionClient {
    private readonly baseUrl: string
    private readonly key: string

    constructor(baseUrl: string, key: string) {
        this.baseUrl = normalizeBaseUrl(baseUrl)
        this.key = key
    }

    async create(
        request: CloudSessionCreateRequest
    ): Promise<CloudSessionCreateResponse> {
        const response = await fetch(`${this.baseUrl}/v1/sessions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.key,
            },
            body: JSON.stringify(request),
        })

        if (!response.ok) {
            throw await parseHttpError(response)
        }

        return (await response.json()) as CloudSessionCreateResponse
    }

    async close(sessionId: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: {
                'x-api-key': this.key,
            },
        })

        if (response.status === 404 || response.status === 204) {
            return
        }

        if (!response.ok) {
            throw await parseHttpError(response)
        }
    }

    async importSelectorCache(
        request: CloudSelectorCacheImportRequest
    ): Promise<CloudSelectorCacheImportResponse> {
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
        entries: CloudSelectorCacheImportRequest['entries']
    ): Promise<CloudSelectorCacheImportResponse> {
        const response = await fetch(`${this.baseUrl}/v1/selector-cache/import`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.key,
            },
            body: JSON.stringify({ entries }),
        })

        // Older backend versions may not implement this endpoint yet.
        if (response.status === 404) {
            return zeroImportResponse()
        }

        if (!response.ok) {
            throw await parseHttpError(response)
        }

        return (await response.json()) as CloudSelectorCacheImportResponse
    }
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '')
}

function zeroImportResponse(): CloudSelectorCacheImportResponse {
    return {
        imported: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
    }
}

function mergeImportResponse(
    first: CloudSelectorCacheImportResponse,
    second: CloudSelectorCacheImportResponse
): CloudSelectorCacheImportResponse {
    return {
        imported: first.imported + second.imported,
        inserted: first.inserted + second.inserted,
        updated: first.updated + second.updated,
        skipped: first.skipped + second.skipped,
    }
}

async function parseHttpError(
    response: Response
): Promise<OpensteerCloudError> {
    let body: CloudHttpErrorBody | null = null

    try {
        body = (await response.json()) as CloudHttpErrorBody
    } catch {
        body = null
    }

    const code =
        typeof body?.code === 'string'
            ? toCloudErrorCode(body.code)
            : ('CLOUD_TRANSPORT_ERROR' as const)
    const message =
        typeof body?.error === 'string'
            ? body.error
            : `Cloud request failed with status ${response.status}.`

    return new OpensteerCloudError(code, message, response.status)
}

function toCloudErrorCode(
    code: string
): CloudErrorCode | 'CLOUD_TRANSPORT_ERROR' {
    if (
        code === 'CLOUD_AUTH_FAILED' ||
        code === 'CLOUD_SESSION_NOT_FOUND' ||
        code === 'CLOUD_SESSION_CLOSED' ||
        code === 'CLOUD_UNSUPPORTED_METHOD' ||
        code === 'CLOUD_INVALID_REQUEST' ||
        code === 'CLOUD_MODEL_NOT_ALLOWED' ||
        code === 'CLOUD_ACTION_FAILED' ||
        code === 'CLOUD_INTERNAL'
    ) {
        return code
    }

    return 'CLOUD_TRANSPORT_ERROR'
}
