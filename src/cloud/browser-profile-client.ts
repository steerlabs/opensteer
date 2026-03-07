import type { OpensteerAuthScheme } from '../types.js'
import type {
    BrowserProfileCreateRequest,
    BrowserProfileDescriptor,
    BrowserProfileListResponse,
    BrowserProfileStatus,
} from './contracts.js'
import {
    cloudAuthHeaders,
    normalizeCloudBaseUrl,
    parseCloudHttpError,
} from './http-client.js'

export interface BrowserProfileListRequest {
    cursor?: string
    limit?: number
    status?: BrowserProfileStatus
}

export class BrowserProfileClient {
    private readonly baseUrl: string
    private readonly key: string
    private readonly authScheme: OpensteerAuthScheme

    constructor(
        baseUrl: string,
        key: string,
        authScheme: OpensteerAuthScheme = 'api-key'
    ) {
        this.baseUrl = normalizeCloudBaseUrl(baseUrl)
        this.key = key
        this.authScheme = authScheme
    }

    async list(
        request: BrowserProfileListRequest = {}
    ): Promise<BrowserProfileListResponse> {
        const query = new URLSearchParams()

        if (request.cursor) {
            query.set('cursor', request.cursor)
        }
        if (typeof request.limit === 'number' && Number.isFinite(request.limit)) {
            query.set('limit', String(Math.max(1, Math.trunc(request.limit))))
        }
        if (request.status) {
            query.set('status', request.status)
        }

        const querySuffix = query.toString() ? `?${query.toString()}` : ''
        const response = await fetch(
            `${this.baseUrl}/browser-profiles${querySuffix}`,
            {
                method: 'GET',
                headers: {
                    ...cloudAuthHeaders(this.key, this.authScheme),
                },
            }
        )

        if (!response.ok) {
            throw await parseCloudHttpError(response)
        }

        return (await response.json()) as BrowserProfileListResponse
    }

    async get(profileId: string): Promise<BrowserProfileDescriptor> {
        const normalized = profileId.trim()
        const response = await fetch(
            `${this.baseUrl}/browser-profiles/${encodeURIComponent(normalized)}`,
            {
                method: 'GET',
                headers: {
                    ...cloudAuthHeaders(this.key, this.authScheme),
                },
            }
        )

        if (!response.ok) {
            throw await parseCloudHttpError(response)
        }

        return (await response.json()) as BrowserProfileDescriptor
    }

    async create(
        request: BrowserProfileCreateRequest
    ): Promise<BrowserProfileDescriptor> {
        const response = await fetch(`${this.baseUrl}/browser-profiles`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...cloudAuthHeaders(this.key, this.authScheme),
            },
            body: JSON.stringify(request),
        })

        if (!response.ok) {
            throw await parseCloudHttpError(response)
        }

        return (await response.json()) as BrowserProfileDescriptor
    }
}
