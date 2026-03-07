import { describe, expect, it } from 'vitest'
import {
    assertCompatibleCloudProfileBinding,
    normalizeCloudProfileBinding,
    resolveConfiguredCloudProfileBinding,
    resolveSessionCloudProfileBinding,
} from '../../src/cli/cloud-profile-binding.js'

describe('cloud profile binding helpers', () => {
    it('normalizes empty values to null', () => {
        expect(
            normalizeCloudProfileBinding({
                profileId: '   ',
                reuseIfActive: true,
            })
        ).toBeNull()
    })

    it('reads configured cloud browser profile bindings from config', () => {
        expect(
            resolveConfiguredCloudProfileBinding({
                cloud: {
                    browserProfile: {
                        profileId: ' bp_123 ',
                        reuseIfActive: true,
                    },
                },
            })
        ).toEqual({
            profileId: 'bp_123',
            reuseIfActive: true,
        })
    })

    it('prefers the explicitly requested binding over config defaults', () => {
        expect(
            resolveSessionCloudProfileBinding(
                {
                    cloud: {
                        browserProfile: {
                            profileId: 'bp_configured',
                            reuseIfActive: true,
                        },
                    },
                },
                {
                    profileId: 'bp_requested',
                    reuseIfActive: false,
                }
            )
        ).toEqual({
            profileId: 'bp_requested',
            reuseIfActive: false,
        })
    })

    it('returns null when cloud mode is disabled', () => {
        expect(
            resolveSessionCloudProfileBinding(
                {
                    cloud: false,
                },
                {
                    profileId: 'bp_requested',
                    reuseIfActive: true,
                }
            )
        ).toBeNull()
    })

    it('rejects a new binding for an already-running unbound session', () => {
        expect(() =>
            assertCompatibleCloudProfileBinding(
                'demo',
                null,
                {
                    profileId: 'bp_123',
                    reuseIfActive: true,
                }
            )
        ).toThrow(/already running without a bound cloud browser profile/i)
    })

    it('rejects mismatched bindings for an existing session', () => {
        expect(() =>
            assertCompatibleCloudProfileBinding(
                'demo',
                {
                    profileId: 'bp_active',
                    reuseIfActive: true,
                },
                {
                    profileId: 'bp_requested',
                    reuseIfActive: false,
                }
            )
        ).toThrow(/already bound to cloud browser profile/i)
    })

    it('allows reusing the same binding', () => {
        expect(() =>
            assertCompatibleCloudProfileBinding(
                'demo',
                {
                    profileId: 'bp_123',
                    reuseIfActive: true,
                },
                {
                    profileId: 'bp_123',
                    reuseIfActive: true,
                }
            )
        ).not.toThrow()
    })
})
