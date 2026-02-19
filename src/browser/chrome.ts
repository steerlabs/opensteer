import { homedir, platform } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'

interface ChromePaths {
    executable: string | null
    defaultUserDataDir: string
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

    // Linux
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
