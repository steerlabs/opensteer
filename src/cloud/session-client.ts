import type {
    CloudErrorCode,
    CloudSelectorCacheImportRequest,
    CloudSelectorCacheImportResponse,
    CloudSessionCreateRequest,
    CloudSessionCreateResponse,
} from './contracts.js'
import { OpensteerCloudError } from './errors.js'
import type { OpensteerAuthScheme } from '../types.js'

interface CloudHttpErrorBody {
    error?: string
    code?: string
    details?: Record<string, unknown>
}

const CACHE_IMPORT_BATCH_SIZE = 200

export class CloudSessionClient {
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
        request: CloudSessionCreateRequest
    ): Promise<CloudSessionCreateResponse> {
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

        let body: unknown
        try {
            body = await response.json()
        } catch {
            throw new OpensteerCloudError(
                'CLOUD_CONTRACT_MISMATCH',
                'Invalid cloud session create response: expected a JSON object.',
                response.status
            )
        }

        return parseCreateResponse(body, response.status)
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

        return (await response.json()) as CloudSelectorCacheImportResponse
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

function parseCreateResponse(
    body: unknown,
    status: number
): CloudSessionCreateResponse {
    const root = requireObject(
        body,
        'Invalid cloud session create response: expected a JSON object.',
        status
    )
    const sessionId = requireString(root, 'sessionId', status)
    const actionWsUrl = requireString(root, 'actionWsUrl', status)
    const cdpWsUrl = requireString(root, 'cdpWsUrl', status)
    const actionToken = requireString(root, 'actionToken', status)
    const cdpToken = requireString(root, 'cdpToken', status)
    const cloudSessionUrl = requireString(root, 'cloudSessionUrl', status)
    const cloudSessionRoot = requireObject(
        root.cloudSession,
        'Invalid cloud session create response: cloudSession must be an object.',
        status
    )

    const cloudSession = {
        sessionId: requireString(cloudSessionRoot, 'sessionId', status, 'cloudSession'),
        workspaceId: requireString(
            cloudSessionRoot,
            'workspaceId',
            status,
            'cloudSession'
        ),
        state: requireString(cloudSessionRoot, 'state', status, 'cloudSession'),
        createdAt: requireNumber(cloudSessionRoot, 'createdAt', status, 'cloudSession'),
        sourceType: requireSourceType(cloudSessionRoot, 'sourceType', status, 'cloudSession'),
        sourceRef: optionalString(cloudSessionRoot, 'sourceRef', status, 'cloudSession'),
        label: optionalString(cloudSessionRoot, 'label', status, 'cloudSession'),
    }

    const expiresAt = optionalNumber(root, 'expiresAt', status)
    return {
        sessionId,
        actionWsUrl,
        cdpWsUrl,
        actionToken,
        cdpToken,
        expiresAt,
        cloudSessionUrl,
        cloudSession,
    }
}

function requireObject(
    value: unknown,
    message: string,
    status?: number
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new OpensteerCloudError('CLOUD_CONTRACT_MISMATCH', message, status)
    }
    return value as Record<string, unknown>
}

function requireString(
    source: Record<string, unknown>,
    field: string,
    status: number,
    parent?: string
): string {
    const value = source[field]
    if (typeof value !== 'string' || !value.trim()) {
        throw new OpensteerCloudError(
            'CLOUD_CONTRACT_MISMATCH',
            `Invalid cloud session create response: ${formatFieldPath(
                field,
                parent
            )} must be a non-empty string.`,
            status
        )
    }
    return value
}

function requireNumber(
    source: Record<string, unknown>,
    field: string,
    status: number,
    parent?: string
): number {
    const value = source[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new OpensteerCloudError(
            'CLOUD_CONTRACT_MISMATCH',
            `Invalid cloud session create response: ${formatFieldPath(
                field,
                parent
            )} must be a finite number.`,
            status
        )
    }
    return value
}

function optionalString(
    source: Record<string, unknown>,
    field: string,
    status: number,
    parent?: string
): string | undefined {
    const value = source[field]
    if (value == null) {
        return undefined
    }
    if (typeof value !== 'string') {
        throw new OpensteerCloudError(
            'CLOUD_CONTRACT_MISMATCH',
            `Invalid cloud session create response: ${formatFieldPath(
                field,
                parent
            )} must be a string when present.`,
            status
        )
    }
    return value
}

function optionalNumber(
    source: Record<string, unknown>,
    field: string,
    status: number,
    parent?: string
): number | undefined {
    const value = source[field]
    if (value == null) {
        return undefined
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new OpensteerCloudError(
            'CLOUD_CONTRACT_MISMATCH',
            `Invalid cloud session create response: ${formatFieldPath(
                field,
                parent
            )} must be a finite number when present.`,
            status
        )
    }
    return value
}

function requireSourceType(
    source: Record<string, unknown>,
    field: string,
    status: number,
    parent?: string
): 'agent-thread' | 'agent-run' | 'local-cloud' | 'manual' {
    const value = source[field]
    if (
        value === 'agent-thread' ||
        value === 'agent-run' ||
        value === 'local-cloud' ||
        value === 'manual'
    ) {
        return value
    }

    throw new OpensteerCloudError(
        'CLOUD_CONTRACT_MISMATCH',
        `Invalid cloud session create response: ${formatFieldPath(
            field,
            parent
        )} must be one of "agent-thread", "agent-run", "local-cloud", or "manual".`,
        status
    )
}

function formatFieldPath(field: string, parent?: string): string {
    return parent ? `"${parent}.${field}"` : `"${field}"`
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

    return new OpensteerCloudError(code, message, response.status, body?.details)
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
        code === 'CLOUD_INTERNAL' ||
        code === 'CLOUD_CAPACITY_EXHAUSTED' ||
        code === 'CLOUD_RUNTIME_UNAVAILABLE' ||
        code === 'CLOUD_RUNTIME_MISMATCH' ||
        code === 'CLOUD_SESSION_STALE' ||
        code === 'CLOUD_CONTRACT_MISMATCH' ||
        code === 'CLOUD_CONTROL_PLANE_ERROR'
    ) {
        return code
    }

    return 'CLOUD_TRANSPORT_ERROR'
}
