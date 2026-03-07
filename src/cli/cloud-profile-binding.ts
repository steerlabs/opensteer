import type {
    OpensteerCloudBrowserProfileOptions,
    OpensteerConfig,
} from '../types.js'

export interface CloudProfileBinding {
    profileId: string
    reuseIfActive?: boolean
}

export function normalizeCloudProfileBinding(
    value:
        | Partial<
              Pick<
                  OpensteerCloudBrowserProfileOptions,
                  'profileId' | 'reuseIfActive'
              >
          >
        | null
        | undefined
): CloudProfileBinding | null {
    if (!value) {
        return null
    }

    const profileId =
        typeof value.profileId === 'string' ? value.profileId.trim() : ''
    if (!profileId) {
        return null
    }

    return {
        profileId,
        reuseIfActive:
            typeof value.reuseIfActive === 'boolean'
                ? value.reuseIfActive
                : undefined,
    }
}

export function resolveConfiguredCloudProfileBinding(
    config: OpensteerConfig
): CloudProfileBinding | null {
    if (!isCloudConfigured(config)) {
        return null
    }

    return normalizeCloudProfileBinding(config.cloud.browserProfile)
}

export function resolveSessionCloudProfileBinding(
    config: OpensteerConfig,
    requested: CloudProfileBinding | null
): CloudProfileBinding | null {
    if (!isCloudConfigured(config)) {
        return null
    }

    return requested ?? resolveConfiguredCloudProfileBinding(config)
}

export function assertCompatibleCloudProfileBinding(
    sessionId: string,
    active: CloudProfileBinding | null,
    requested: CloudProfileBinding | null
): void {
    if (!requested) {
        return
    }

    if (!active) {
        throw new Error(
            [
                `Session '${sessionId}' is already running without a bound cloud browser profile.`,
                'Cloud browser profile selection only applies when the session is first opened.',
                'Close this session or use a different --session to target another profile.',
            ].join(' ')
        )
    }

    if (
        active.profileId === requested.profileId &&
        active.reuseIfActive === requested.reuseIfActive
    ) {
        return
    }

    throw new Error(
        [
            `Session '${sessionId}' is already bound to cloud browser profile ${formatCloudProfileBinding(active)}.`,
            `Requested ${formatCloudProfileBinding(requested)} does not match.`,
            'Use the same cloud profile for this session, or start a different --session.',
        ].join(' ')
    )
}

function formatCloudProfileBinding(binding: CloudProfileBinding): string {
    if (binding.reuseIfActive === undefined) {
        return `'${binding.profileId}'`
    }

    return `'${binding.profileId}' (reuseIfActive=${String(
        binding.reuseIfActive
    )})`
}

function isCloudConfigured(config: OpensteerConfig): config is OpensteerConfig & {
    cloud: Exclude<OpensteerConfig['cloud'], boolean | undefined>
} {
    return Boolean(
        config.cloud &&
            typeof config.cloud === 'object' &&
            !Array.isArray(config.cloud)
    )
}
