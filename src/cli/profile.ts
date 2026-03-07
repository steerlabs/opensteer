import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Cookie } from 'playwright'
import { resolveConfigWithEnv } from '../config.js'
import { Opensteer } from '../opensteer.js'
import type {
    OpensteerConfig,
    OpensteerAuthScheme,
    OpensteerCloudBrowserProfileOptions,
    CookieParam,
} from '../types.js'
import { expandHome } from '../browser/chrome.js'
import { loadCookiesFromLocalProfileDir } from '../browser/chromium-profile.js'
import {
    BrowserProfileClient,
    type BrowserProfileListRequest,
} from '../cloud/browser-profile-client.js'
import {
    type BrowserProfileCreateRequest,
    type BrowserProfileDescriptor,
    type BrowserProfileListResponse,
    type BrowserProfileStatus,
} from '../cloud/contracts.js'
import { prepareCookiesForSync } from './profile-sync.js'
import { ensureCloudCredentialsForCommand } from './auth.js'

export type ParsedProfileArgs =
    | { mode: 'help' }
    | { mode: 'error'; error: string }
    | { mode: 'list'; args: ProfileListArgs }
    | { mode: 'create'; args: ProfileCreateArgs }
    | { mode: 'sync'; args: ProfileSyncArgs }

export interface ProfileCommonCloudArgs {
    apiKey?: string
    accessToken?: string
    baseUrl?: string
    siteUrl?: string
    authScheme?: OpensteerAuthScheme
    json?: boolean
}

export interface ProfileListArgs extends ProfileCommonCloudArgs {
    cursor?: string
    limit?: number
    status?: BrowserProfileStatus
}

export interface ProfileCreateArgs extends ProfileCommonCloudArgs {
    name: string
}

export interface ProfileSyncArgs extends ProfileCommonCloudArgs {
    fromProfileDir: string
    toProfileId?: string
    name?: string
    domains: string[]
    allDomains: boolean
    dryRun: boolean
    yes: boolean
    headless: boolean
}

interface CloudAuthContext {
    token: string
    baseUrl: string
    siteUrl: string
    authScheme: OpensteerAuthScheme
    kind: 'api-key' | 'access-token'
    source: 'flag' | 'env' | 'saved'
}

interface BrowserProfileClientLike {
    list(request?: BrowserProfileListRequest): Promise<BrowserProfileListResponse>
    create(request: BrowserProfileCreateRequest): Promise<BrowserProfileDescriptor>
}

interface OpensteerLike {
    launch(options?: Record<string, unknown>): Promise<void>
    close(): Promise<void>
    getCookies(url?: string): Promise<Cookie[]>
    readonly context: {
        addCookies(cookies: CookieParam[]): Promise<void>
    }
}

interface ProfileCliDeps {
    readonly env: Record<string, string | undefined>
    readonly createBrowserProfileClient: (
        context: CloudAuthContext
    ) => BrowserProfileClientLike
    readonly createOpensteer: (config: OpensteerConfig) => OpensteerLike
    readonly loadLocalProfileCookies: (
        profileDir: string
    ) => Promise<Cookie[] | null>
    readonly isInteractive: () => boolean
    readonly confirm: (message: string) => Promise<boolean>
    readonly writeStdout: (message: string) => void
    readonly writeStderr: (message: string) => void
}

const HELP_TEXT = `Usage: opensteer profile <command> [options]

Manage cloud browser profiles and sync local cookie state into cloud profiles.

Commands:
  list                      List cloud browser profiles
  create --name <name>      Create a cloud browser profile
  sync                      Sync local profile cookies to cloud

Cloud auth options (all commands):
  --api-key <key>           Cloud API key (defaults to OPENSTEER_API_KEY)
  --access-token <token>    Cloud bearer access token (defaults to OPENSTEER_ACCESS_TOKEN)
  --base-url <url>          Cloud API base URL (defaults to env or the last selected host)
  --site-url <url>          Cloud site URL for login/refresh/revoke flows
  --auth-scheme <scheme>    api-key (default) or bearer
  --json                    JSON output (progress logs go to stderr)

Sync options:
  --from-profile-dir <dir>  Local browser profile directory or Chromium user-data dir to read cookies from (required)
  --to-profile-id <id>      Destination cloud profile id
  --name <name>             Create destination cloud profile with this name if --to-profile-id is omitted
  --domain <domain>         Restrict sync to one domain (repeatable)
  --all-domains             Explicitly sync all domains
  --dry-run                 Analyze cookies and scope without uploading to cloud
  --yes                     Required for non-interactive execution
  --headless <true|false>   Browser headless mode for local/cloud sync sessions (default: true)
  -h, --help                Show this help

Examples:
  opensteer profile list
  opensteer profile create --name "My Session Profile"
  opensteer profile sync --from-profile-dir ~/Library/Application\\ Support/Google/Chrome/Default --to-profile-id bp_123 --domain github.com
  opensteer profile sync --from-profile-dir ./my-profile --name "Imported Profile" --all-domains --yes
`

function parseBooleanValue(
    raw: string,
    flag: string
): { ok: true; value: boolean } | { ok: false; error: string } {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') {
        return { ok: true, value: true }
    }
    if (normalized === 'false' || normalized === '0') {
        return { ok: true, value: false }
    }

    return {
        ok: false,
        error: `${flag} must be "true" or "false".`,
    }
}

function parseAuthScheme(raw: string): OpensteerAuthScheme | null {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'api-key' || normalized === 'bearer') {
        return normalized
    }
    return null
}

function isBrowserProfileStatus(value: string): value is BrowserProfileStatus {
    return value === 'active' || value === 'archived' || value === 'error'
}

function readFlagValue(
    args: string[],
    index: number,
    flag: string
): { ok: true; value: string; nextIndex: number } | { ok: false; error: string } {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
        return {
            ok: false,
            error: `${flag} requires a value.`,
        }
    }
    return {
        ok: true,
        value,
        nextIndex: index + 1,
    }
}

function parseListArgs(rawArgs: string[]): ParsedProfileArgs {
    const args: ProfileListArgs = {}

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i]
        if (arg === '--json') {
            args.json = true
            continue
        }
        if (arg === '--api-key') {
            const value = readFlagValue(rawArgs, i, '--api-key')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.apiKey = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--access-token') {
            const value = readFlagValue(rawArgs, i, '--access-token')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.accessToken = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--base-url') {
            const value = readFlagValue(rawArgs, i, '--base-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.baseUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--site-url') {
            const value = readFlagValue(rawArgs, i, '--site-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.siteUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--auth-scheme') {
            const value = readFlagValue(rawArgs, i, '--auth-scheme')
            if (!value.ok) return { mode: 'error', error: value.error }
            const parsed = parseAuthScheme(value.value)
            if (!parsed) {
                return {
                    mode: 'error',
                    error: '--auth-scheme must be "api-key" or "bearer".',
                }
            }
            args.authScheme = parsed
            i = value.nextIndex
            continue
        }
        if (arg === '--cursor') {
            const value = readFlagValue(rawArgs, i, '--cursor')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.cursor = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--limit') {
            const value = readFlagValue(rawArgs, i, '--limit')
            if (!value.ok) return { mode: 'error', error: value.error }
            const parsed = Number.parseInt(value.value, 10)
            if (!Number.isInteger(parsed) || parsed <= 0) {
                return {
                    mode: 'error',
                    error: '--limit must be a positive integer.',
                }
            }
            args.limit = parsed
            i = value.nextIndex
            continue
        }
        if (arg === '--status') {
            const value = readFlagValue(rawArgs, i, '--status')
            if (!value.ok) return { mode: 'error', error: value.error }
            const status = value.value.trim()
            if (!isBrowserProfileStatus(status)) {
                return {
                    mode: 'error',
                    error: '--status must be one of: active, archived, error.',
                }
            }
            args.status = status
            i = value.nextIndex
            continue
        }

        return {
            mode: 'error',
            error: `Unsupported option "${arg}" for "opensteer profile list".`,
        }
    }

    return { mode: 'list', args }
}

function parseCreateArgs(rawArgs: string[]): ParsedProfileArgs {
    const args: Partial<ProfileCreateArgs> = {}

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i]
        if (arg === '--json') {
            args.json = true
            continue
        }
        if (arg === '--name') {
            const value = readFlagValue(rawArgs, i, '--name')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.name = value.value.trim()
            i = value.nextIndex
            continue
        }
        if (arg === '--api-key') {
            const value = readFlagValue(rawArgs, i, '--api-key')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.apiKey = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--access-token') {
            const value = readFlagValue(rawArgs, i, '--access-token')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.accessToken = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--base-url') {
            const value = readFlagValue(rawArgs, i, '--base-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.baseUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--site-url') {
            const value = readFlagValue(rawArgs, i, '--site-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.siteUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--auth-scheme') {
            const value = readFlagValue(rawArgs, i, '--auth-scheme')
            if (!value.ok) return { mode: 'error', error: value.error }
            const parsed = parseAuthScheme(value.value)
            if (!parsed) {
                return {
                    mode: 'error',
                    error: '--auth-scheme must be "api-key" or "bearer".',
                }
            }
            args.authScheme = parsed
            i = value.nextIndex
            continue
        }

        return {
            mode: 'error',
            error: `Unsupported option "${arg}" for "opensteer profile create".`,
        }
    }

    if (!args.name) {
        return {
            mode: 'error',
            error: '--name is required for "opensteer profile create".',
        }
    }

    return {
        mode: 'create',
        args: {
            ...args,
            name: args.name,
        },
    }
}

function parseSyncArgs(rawArgs: string[]): ParsedProfileArgs {
    const args: ProfileSyncArgs = {
        fromProfileDir: '',
        domains: [],
        allDomains: false,
        dryRun: false,
        yes: false,
        headless: true,
    }

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i]
        if (arg === '--json') {
            args.json = true
            continue
        }
        if (arg === '--all-domains') {
            args.allDomains = true
            continue
        }
        if (arg === '--dry-run') {
            args.dryRun = true
            continue
        }
        if (arg === '--yes') {
            args.yes = true
            continue
        }
        if (arg === '--from-profile-dir') {
            const value = readFlagValue(rawArgs, i, '--from-profile-dir')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.fromProfileDir = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--to-profile-id') {
            const value = readFlagValue(rawArgs, i, '--to-profile-id')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.toProfileId = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--name') {
            const value = readFlagValue(rawArgs, i, '--name')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.name = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--domain') {
            const value = readFlagValue(rawArgs, i, '--domain')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.domains.push(value.value)
            i = value.nextIndex
            continue
        }
        if (arg === '--headless') {
            const value = readFlagValue(rawArgs, i, '--headless')
            if (!value.ok) return { mode: 'error', error: value.error }
            const parsed = parseBooleanValue(value.value, '--headless')
            if (!parsed.ok) return { mode: 'error', error: parsed.error }
            args.headless = parsed.value
            i = value.nextIndex
            continue
        }
        if (arg === '--api-key') {
            const value = readFlagValue(rawArgs, i, '--api-key')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.apiKey = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--access-token') {
            const value = readFlagValue(rawArgs, i, '--access-token')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.accessToken = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--base-url') {
            const value = readFlagValue(rawArgs, i, '--base-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.baseUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--site-url') {
            const value = readFlagValue(rawArgs, i, '--site-url')
            if (!value.ok) return { mode: 'error', error: value.error }
            args.siteUrl = value.value
            i = value.nextIndex
            continue
        }
        if (arg === '--auth-scheme') {
            const value = readFlagValue(rawArgs, i, '--auth-scheme')
            if (!value.ok) return { mode: 'error', error: value.error }
            const parsed = parseAuthScheme(value.value)
            if (!parsed) {
                return {
                    mode: 'error',
                    error: '--auth-scheme must be "api-key" or "bearer".',
                }
            }
            args.authScheme = parsed
            i = value.nextIndex
            continue
        }

        return {
            mode: 'error',
            error: `Unsupported option "${arg}" for "opensteer profile sync".`,
        }
    }

    if (!args.fromProfileDir.trim()) {
        return {
            mode: 'error',
            error: '--from-profile-dir is required for "opensteer profile sync".',
        }
    }

    if (args.allDomains && args.domains.length > 0) {
        return {
            mode: 'error',
            error: 'Use either --all-domains or --domain, not both.',
        }
    }

    return { mode: 'sync', args }
}

export function parseOpensteerProfileArgs(rawArgs: string[]): ParsedProfileArgs {
    if (!rawArgs.length) {
        return { mode: 'help' }
    }

    const [subcommand, ...rest] = rawArgs
    if (
        subcommand === '--help' ||
        subcommand === '-h' ||
        subcommand === 'help'
    ) {
        return { mode: 'help' }
    }

    if (subcommand === 'list') {
        return parseListArgs(rest)
    }
    if (subcommand === 'create') {
        return parseCreateArgs(rest)
    }
    if (subcommand === 'sync') {
        return parseSyncArgs(rest)
    }

    return {
        mode: 'error',
        error: `Unsupported profile subcommand "${subcommand}".`,
    }
}

function createDefaultDeps(): ProfileCliDeps {
    return {
        env: process.env,
        createBrowserProfileClient: (context) =>
            new BrowserProfileClient(
                context.baseUrl,
                context.token,
                context.authScheme
            ),
        createOpensteer: (config) => new Opensteer(config),
        loadLocalProfileCookies: (profileDir) =>
            loadCookiesFromLocalProfileDir(profileDir),
        isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
        confirm: async (message) => {
            const rl = createInterface({
                input: process.stdin,
                output: process.stderr,
            })
            try {
                const answer = await rl.question(`${message} [y/N] `)
                const normalized = answer.trim().toLowerCase()
                return normalized === 'y' || normalized === 'yes'
            } finally {
                rl.close()
            }
        },
        writeStdout: (message) => process.stdout.write(message),
        writeStderr: (message) => process.stderr.write(message),
    }
}

async function buildCloudAuthContext(
    args: ProfileCommonCloudArgs,
    deps: ProfileCliDeps
): Promise<CloudAuthContext> {
    const ensured = await ensureCloudCredentialsForCommand({
        commandName: 'opensteer profile',
        env: deps.env,
        apiKeyFlag: args.apiKey,
        accessTokenFlag: args.accessToken,
        baseUrl: args.baseUrl,
        siteUrl: args.siteUrl,
        interactive: deps.isInteractive(),
        autoLoginIfNeeded: true,
        writeStdout: args.json ? deps.writeStderr : deps.writeStdout,
        writeStderr: deps.writeStderr,
    })

    if (args.authScheme) {
        if (ensured.kind === 'access-token' && args.authScheme !== 'bearer') {
            throw new Error(
                '--auth-scheme=api-key is incompatible with --access-token or saved login credentials.'
            )
        }
        if (ensured.kind === 'api-key' && args.authScheme === 'bearer') {
            return {
                ...ensured,
                authScheme: 'bearer',
            }
        }
    }

    return {
        token: ensured.token,
        baseUrl: ensured.baseUrl,
        siteUrl: ensured.siteUrl,
        authScheme: ensured.authScheme,
        kind: ensured.kind,
        source: ensured.source,
    }
}

function printProfileHelp(deps: ProfileCliDeps): void {
    deps.writeStdout(`${HELP_TEXT}\n`)
}

function writeJson(deps: ProfileCliDeps, payload: unknown): void {
    deps.writeStdout(`${JSON.stringify(payload)}\n`)
}

function writeHumanLine(deps: ProfileCliDeps, message: string): void {
    deps.writeStdout(`${message}\n`)
}

function writeProgressLine(deps: ProfileCliDeps, jsonOutput: boolean, message: string): void {
    if (jsonOutput) {
        deps.writeStderr(`${message}\n`)
        return
    }
    deps.writeStdout(`${message}\n`)
}

async function runList(args: ProfileListArgs, deps: ProfileCliDeps): Promise<number> {
    const auth = await buildCloudAuthContext(args, deps)
    const client = deps.createBrowserProfileClient(auth)
    const response = await client.list({
        cursor: args.cursor,
        limit: args.limit,
        status: args.status,
    })

    if (args.json) {
        writeJson(deps, response)
        return 0
    }

    if (!response.profiles.length) {
        writeHumanLine(deps, 'No cloud browser profiles found.')
        return 0
    }

    writeHumanLine(deps, `Cloud browser profiles (${response.profiles.length}):`)
    for (const profile of response.profiles) {
        writeHumanLine(
            deps,
            `  ${profile.profileId}  ${profile.name}  [${profile.status}]`
        )
    }
    if (response.nextCursor) {
        writeHumanLine(
            deps,
            `Next cursor: ${response.nextCursor}`
        )
    }
    return 0
}

async function runCreate(args: ProfileCreateArgs, deps: ProfileCliDeps): Promise<number> {
    const auth = await buildCloudAuthContext(args, deps)
    const client = deps.createBrowserProfileClient(auth)
    const profile = await client.create({
        name: args.name,
    })

    if (args.json) {
        writeJson(deps, profile)
        return 0
    }

    writeHumanLine(
        deps,
        `Created cloud browser profile "${profile.name}" (${profile.profileId}).`
    )
    return 0
}

async function importCookiesInBatches(
    context: { addCookies(cookies: CookieParam[]): Promise<void> },
    cookies: CookieParam[],
    batchSize = 100
): Promise<{ imported: number; skipped: number }> {
    let imported = 0
    let skipped = 0

    for (let offset = 0; offset < cookies.length; offset += batchSize) {
        const batch = cookies.slice(offset, offset + batchSize)
        try {
            await context.addCookies(batch)
            imported += batch.length
        } catch {
            for (const cookie of batch) {
                try {
                    await context.addCookies([cookie])
                    imported += 1
                } catch {
                    skipped += 1
                }
            }
        }
    }

    return {
        imported,
        skipped,
    }
}

async function resolveTargetProfileId(
    args: ProfileSyncArgs,
    deps: ProfileCliDeps,
    client: BrowserProfileClientLike
): Promise<{ profileId: string; created: boolean }> {
    const explicitProfileId = args.toProfileId?.trim()
    if (explicitProfileId) {
        return {
            profileId: explicitProfileId,
            created: false,
        }
    }

    const requestedName = args.name?.trim()
    if (requestedName) {
        const profile = await client.create({
            name: requestedName,
        })
        return {
            profileId: profile.profileId,
            created: true,
        }
    }

    if (!deps.isInteractive()) {
        throw new Error(
            'Sync target is required in non-interactive mode. Use --to-profile-id <id> or --name <name>.'
        )
    }

    const defaultName = `Synced ${path.basename(args.fromProfileDir)}`
    const shouldCreate = await deps.confirm(
        `No destination profile provided. Create a new cloud profile named "${defaultName}"?`
    )
    if (!shouldCreate) {
        throw new Error(
            'Profile sync cancelled. Provide --to-profile-id or --name to choose a destination profile.'
        )
    }

    const created = await client.create({
        name: defaultName,
    })
    return {
        profileId: created.profileId,
        created: true,
    }
}

function resolveSyncBrowserProfilePreference(
    profileId: string,
    env: Record<string, string | undefined>
): OpensteerCloudBrowserProfileOptions {
    const resolved = resolveConfigWithEnv({
        cloud: true,
    }, {
        env,
    }).config
    const cloudConfig =
        resolved.cloud && typeof resolved.cloud === 'object'
            ? resolved.cloud
            : undefined
    const configured = cloudConfig?.browserProfile

    if (
        configured &&
        configured.profileId.trim() === profileId &&
        configured.reuseIfActive !== undefined
    ) {
        return {
            profileId,
            reuseIfActive: configured.reuseIfActive,
        }
    }

    return { profileId }
}

async function runSync(args: ProfileSyncArgs, deps: ProfileCliDeps): Promise<number> {
    const sourceProfileDir = expandHome(args.fromProfileDir.trim())
    const nonInteractive = !deps.isInteractive()
    const hasExplicitScope = args.allDomains || args.domains.length > 0

    if (nonInteractive && !args.yes) {
        throw new Error(
            'Non-interactive profile sync requires --yes.'
        )
    }
    if (nonInteractive && !hasExplicitScope) {
        throw new Error(
            'Non-interactive profile sync requires explicit scope: --domain <domain> (repeatable) or --all-domains.'
        )
    }

    if (!hasExplicitScope && !nonInteractive) {
        const confirmed = await deps.confirm(
            'No domain filter provided. Sync cookies for all domains?'
        )
        if (!confirmed) {
            throw new Error(
                'Profile sync cancelled. Use --domain <domain> or --all-domains.'
            )
        }
    }

    writeProgressLine(
        deps,
        Boolean(args.json),
        `Reading cookies from local profile: ${sourceProfileDir}`
    )

    let sourceCookies: Cookie[] = []
    const directCookies = await deps.loadLocalProfileCookies(sourceProfileDir)
    if (directCookies) {
        sourceCookies = directCookies
    } else {
        const local = deps.createOpensteer({
            cloud: false,
            cursor: { enabled: false },
            browser: {
                headless: args.headless,
                profileDir: sourceProfileDir,
            },
        })
        try {
            await local.launch({
                headless: args.headless,
                profileDir: sourceProfileDir,
                timeout: 120_000,
            })
            sourceCookies = await local.getCookies()
        } finally {
            await local.close().catch(() => undefined)
        }
    }

    const prepared = prepareCookiesForSync(sourceCookies, {
        domains: args.allDomains ? [] : args.domains,
    })

    if (!prepared.cookies.length) {
        throw new Error(
            'No syncable cookies found for the selected profile and scope.'
        )
    }

    if (args.dryRun) {
        const payload = {
            success: true,
            dryRun: true,
            profileId: args.toProfileId?.trim() || null,
            createdProfile: false,
            totalCookies: prepared.totalCookies,
            matchedCookies: prepared.matchedCookies,
            dedupedCookies: prepared.dedupedCookies,
            droppedInvalid: prepared.droppedInvalid,
            filteredDomains: prepared.filteredDomains,
            domainCounts: prepared.domainCounts,
        }
        if (args.json) {
            writeJson(deps, payload)
        } else {
            writeHumanLine(deps, 'Dry run complete.')
            writeHumanLine(deps, `  Total cookies: ${prepared.totalCookies}`)
            writeHumanLine(deps, `  Scope-matched cookies: ${prepared.matchedCookies}`)
            writeHumanLine(deps, `  Deduped cookies: ${prepared.dedupedCookies}`)
            writeHumanLine(deps, `  Dropped invalid: ${prepared.droppedInvalid}`)
            if (prepared.filteredDomains.length) {
                writeHumanLine(
                    deps,
                    `  Domain filters: ${prepared.filteredDomains.join(', ')}`
                )
            } else {
                writeHumanLine(deps, '  Domain scope: all domains')
            }
        }
        return 0
    }

    const auth = await buildCloudAuthContext(args, deps)
    const client = deps.createBrowserProfileClient(auth)
    const target = await resolveTargetProfileId(args, deps, client)
    const targetBrowserProfile = resolveSyncBrowserProfilePreference(
        target.profileId,
        deps.env
    )

    writeProgressLine(
        deps,
        Boolean(args.json),
        `Importing ${prepared.cookies.length} cookies into cloud profile ${target.profileId}`
    )

    const cloud = deps.createOpensteer({
        cloud: {
            ...(auth.kind === 'api-key'
                ? { apiKey: auth.token }
                : { accessToken: auth.token }),
            baseUrl: auth.baseUrl,
            authScheme: auth.authScheme,
            browserProfile: targetBrowserProfile,
        },
        cursor: { enabled: false },
    })

    let imported = 0
    let skipped = 0
    try {
        await cloud.launch({
            headless: args.headless,
            timeout: 120_000,
        })
        const result = await importCookiesInBatches(cloud.context, prepared.cookies)
        imported = result.imported
        skipped = result.skipped
    } finally {
        await cloud.close().catch(() => undefined)
    }

    const payload = {
        success: true,
        profileId: target.profileId,
        createdProfile: target.created,
        totalCookies: prepared.totalCookies,
        matchedCookies: prepared.matchedCookies,
        dedupedCookies: prepared.dedupedCookies,
        droppedInvalid: prepared.droppedInvalid,
        importedCookies: imported,
        skippedCookies: skipped,
        filteredDomains: prepared.filteredDomains,
        domainCounts: prepared.domainCounts,
    }

    if (args.json) {
        writeJson(deps, payload)
        return 0
    }

    writeHumanLine(deps, 'Profile cookie sync complete.')
    writeHumanLine(deps, `  Cloud profile: ${target.profileId}`)
    writeHumanLine(deps, `  Imported cookies: ${imported}`)
    writeHumanLine(deps, `  Skipped cookies: ${skipped}`)
    if (prepared.filteredDomains.length) {
        writeHumanLine(
            deps,
            `  Domain filters: ${prepared.filteredDomains.join(', ')}`
        )
    } else {
        writeHumanLine(deps, '  Domain scope: all domains')
    }
    return 0
}

export async function runOpensteerProfileCli(
    rawArgs: string[],
    overrideDeps: Partial<ProfileCliDeps> = {}
): Promise<number> {
    const deps: ProfileCliDeps = {
        ...createDefaultDeps(),
        ...overrideDeps,
    }
    const parsed = parseOpensteerProfileArgs(rawArgs)
    if (parsed.mode === 'help') {
        printProfileHelp(deps)
        return 0
    }
    if (parsed.mode === 'error') {
        deps.writeStderr(`${parsed.error}\n`)
        deps.writeStderr('Run "opensteer profile --help" for usage.\n')
        return 1
    }

    try {
        if (parsed.mode === 'list') {
            return await runList(parsed.args, deps)
        }
        if (parsed.mode === 'create') {
            return await runCreate(parsed.args, deps)
        }
        return await runSync(parsed.args, deps)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Profile command failed.'
        deps.writeStderr(`${message}\n`)
        return 1
    }
}
