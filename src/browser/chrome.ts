import { homedir, platform } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'

interface ChromePaths {
    executable: string | null
    defaultUserDataDir: string
}

export interface LocalChromeProfileDescriptor {
    directory: string
    name: string
}

/** Resolve platform-specific Chrome paths. */
export function detectChromePaths(): ChromePaths {
    const os = platform()

    if (os === 'darwin') {
        const executable =
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        return {
            executable: existsSync(executable) ? executable : null,
            defaultUserDataDir: join(
                homedir(),
                'Library',
                'Application Support',
                'Google',
                'Chrome'
            ),
        }
    }

    if (os === 'win32') {
        const executable = join(
            process.env.PROGRAMFILES || 'C:\\Program Files',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
        )
        return {
            executable: existsSync(executable) ? executable : null,
            defaultUserDataDir: join(
                process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
                'Google',
                'Chrome',
                'User Data'
            ),
        }
    }

    const executable = '/usr/bin/google-chrome'
    return {
        executable: existsSync(executable) ? executable : null,
        defaultUserDataDir: join(homedir(), '.config', 'google-chrome'),
    }
}

/** Expand ~ to home directory in a path. */
export function expandHome(p: string): string {
    if (p.startsWith('~/') || p === '~') {
        return join(homedir(), p.slice(1))
    }
    return p
}

export function listLocalChromeProfiles(
    userDataDir = detectChromePaths().defaultUserDataDir
): LocalChromeProfileDescriptor[] {
    const resolvedUserDataDir = expandHome(userDataDir)
    const localStatePath = join(resolvedUserDataDir, 'Local State')
    if (!existsSync(localStatePath)) {
        return []
    }

    try {
        const raw = JSON.parse(readFileSync(localStatePath, 'utf-8'))
        const infoCache =
            raw &&
            typeof raw === 'object' &&
            !Array.isArray(raw) &&
            raw.profile &&
            typeof raw.profile === 'object' &&
            !Array.isArray(raw.profile)
                ? (raw.profile as { info_cache?: Record<string, unknown> })
                      .info_cache
                : undefined

        if (!infoCache || typeof infoCache !== 'object') {
            return []
        }

        return Object.entries(infoCache)
            .map(([directory, info]) => {
                const record =
                    info && typeof info === 'object' && !Array.isArray(info)
                        ? (info as Record<string, unknown>)
                        : {}
                const name =
                    typeof record.name === 'string' && record.name.trim()
                        ? record.name.trim()
                        : directory

                return {
                    directory,
                    name,
                }
            })
            .filter((profile) => profile.directory.trim().length > 0)
            .sort((left, right) =>
                left.directory.localeCompare(right.directory)
            )
    } catch {
        return []
    }
}
