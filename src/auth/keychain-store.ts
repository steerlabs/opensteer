import { spawnSync } from 'node:child_process'

export type KeychainBackend = 'macos-security' | 'linux-secret-tool'

export interface KeychainStore {
    readonly backend: KeychainBackend
    get(service: string, account: string): string | null
    set(service: string, account: string, secret: string): void
    delete(service: string, account: string): void
}

function commandExists(command: string): boolean {
    const result = spawnSync(command, ['--help'], {
        encoding: 'utf8',
        stdio: 'ignore',
    })
    return result.error == null
}

function commandFailed(result: ReturnType<typeof spawnSync>): boolean {
    return typeof result.status === 'number' && result.status !== 0
}

function sanitizeCommandArgs(command: string, args: string[]): string[] {
    if (command !== 'security') {
        return args
    }

    const sanitized: string[] = []
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index]
        sanitized.push(value)
        if (value === '-w' && index + 1 < args.length) {
            sanitized.push('[REDACTED]')
            index += 1
        }
    }
    return sanitized
}

function buildCommandError(
    command: string,
    args: string[],
    result: ReturnType<typeof spawnSync>
): Error {
    const stderr =
        typeof result.stderr === 'string' && result.stderr.trim()
            ? result.stderr.trim()
            : `Command "${command}" failed with status ${String(result.status)}.`

    const sanitizedArgs = sanitizeCommandArgs(command, args)
    return new Error(
        [
            `Unable to persist credential via ${command}.`,
            `${command} ${sanitizedArgs.join(' ')}`,
            stderr,
        ].join(' ')
    )
}

function createMacosSecurityStore(): KeychainStore {
    return {
        backend: 'macos-security',
        get(service: string, account: string): string | null {
            const result = spawnSync(
                'security',
                ['find-generic-password', '-s', service, '-a', account, '-w'],
                { encoding: 'utf8' }
            )

            if (commandFailed(result)) {
                return null
            }

            const secret = result.stdout.trim()
            return secret.length ? secret : null
        },
        set(service: string, account: string, secret: string): void {
            const args = [
                'add-generic-password',
                '-U',
                '-s',
                service,
                '-a',
                account,
                '-w',
                secret,
            ]
            const result = spawnSync('security', args, { encoding: 'utf8' })
            if (commandFailed(result)) {
                throw buildCommandError('security', args, result)
            }
        },
        delete(service: string, account: string): void {
            const args = ['delete-generic-password', '-s', service, '-a', account]
            const result = spawnSync('security', args, { encoding: 'utf8' })
            if (commandFailed(result)) {
                return
            }
        },
    }
}

function createLinuxSecretToolStore(): KeychainStore {
    return {
        backend: 'linux-secret-tool',
        get(service: string, account: string): string | null {
            const result = spawnSync(
                'secret-tool',
                ['lookup', 'service', service, 'account', account],
                {
                    encoding: 'utf8',
                }
            )

            if (commandFailed(result)) {
                return null
            }

            const secret = result.stdout.trim()
            return secret.length ? secret : null
        },
        set(service: string, account: string, secret: string): void {
            const args = [
                'store',
                '--label',
                'Opensteer CLI',
                'service',
                service,
                'account',
                account,
            ]
            const result = spawnSync('secret-tool', args, {
                encoding: 'utf8',
                input: secret,
            })
            if (commandFailed(result)) {
                throw buildCommandError('secret-tool', args, result)
            }
        },
        delete(service: string, account: string): void {
            const args = ['clear', 'service', service, 'account', account]
            spawnSync('secret-tool', args, {
                encoding: 'utf8',
            })
        },
    }
}

export function createKeychainStore(): KeychainStore | null {
    if (process.platform === 'darwin') {
        if (!commandExists('security')) {
            return null
        }
        return createMacosSecurityStore()
    }

    if (process.platform === 'linux') {
        if (!commandExists('secret-tool')) {
            return null
        }
        return createLinuxSecretToolStore()
    }

    return null
}
