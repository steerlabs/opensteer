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

        let body: unknown
        try {
            body = await response.json()
        } catch {
            throw new OpensteerRemoteError(
                'REMOTE_CONTRACT_MISMATCH',
                'Invalid remote session create response: expected a JSON object.',
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

function parseCreateResponse(
    body: unknown,
    status: number
): RemoteSessionCreateResponse {
    const root = requireObject(
        body,
        'Invalid remote session create response: expected a JSON object.',
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
        'Invalid remote session create response: cloudSession must be an object.',
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
        throw new OpensteerRemoteError('REMOTE_CONTRACT_MISMATCH', message, status)
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
        throw new OpensteerRemoteError(
            'REMOTE_CONTRACT_MISMATCH',
            `Invalid remote session create response: ${formatFieldPath(
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
        throw new OpensteerRemoteError(
            'REMOTE_CONTRACT_MISMATCH',
            `Invalid remote session create response: ${formatFieldPath(
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
        throw new OpensteerRemoteError(
            'REMOTE_CONTRACT_MISMATCH',
            `Invalid remote session create response: ${formatFieldPath(
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
        throw new OpensteerRemoteError(
            'REMOTE_CONTRACT_MISMATCH',
            `Invalid remote session create response: ${formatFieldPath(
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

    throw new OpensteerRemoteError(
        'REMOTE_CONTRACT_MISMATCH',
        `Invalid remote session create response: ${formatFieldPath(
            field,
            parent
        )} must be one of "agent-thread", "agent-run", "local-cloud", or "manual".`,
        status
    )
}

function formatFieldPath(field: string, parent?: string): string {
    return parent ? `"${parent}.${field}"` : `"${field}"`
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
        code === 'REMOTE_CONTRACT_MISMATCH' ||
        code === 'REMOTE_CONTROL_PLANE_ERROR'
    ) {
        return code
    }

    return 'REMOTE_TRANSPORT_ERROR'
}
