import type {
    OpensteerBrowserConfig,
    OpensteerLocalBrowserMode,
} from '../types.js'

type CliBrowserRequestConfig = Pick<
    OpensteerBrowserConfig,
    | 'mode'
    | 'headless'
    | 'cdpUrl'
    | 'profileDirectory'
    | 'userDataDir'
    | 'executablePath'
>

export function resolveCliBrowserRequestConfig(
    options: {
        browser?: OpensteerLocalBrowserMode
        headless?: boolean
        cdpUrl?: string
        profileDirectory?: string
        userDataDir?: string
        executablePath?: string
    }
): CliBrowserRequestConfig {
    const mode =
        options.browser ??
        (options.profileDirectory ||
        options.userDataDir ||
        options.executablePath
            ? 'real'
            : undefined)

    return {
        mode,
        headless: options.headless ?? (mode === 'real' ? true : undefined),
        cdpUrl: options.cdpUrl,
        profileDirectory: options.profileDirectory,
        userDataDir: options.userDataDir,
        executablePath: options.executablePath,
    }
}
