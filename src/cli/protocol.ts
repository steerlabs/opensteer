export interface CliRequest {
    id: number
    command: string
    args: Record<string, unknown>
}

export interface CliResponse {
    id: number
    ok: boolean
    result?: unknown
    error?: string
}
