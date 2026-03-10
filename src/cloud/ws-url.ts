export function withTokenQuery(wsUrl: string, token: string): string {
    const url = new URL(wsUrl)
    url.searchParams.set('token', token)
    return url.toString()
}
