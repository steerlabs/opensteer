import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { listLocalChromeProfiles } from '../../src/browser/chrome.js'

describe('listLocalChromeProfiles', () => {
    it('reads profile descriptors from Chrome Local State', async () => {
        const userDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-local-profiles-')
        )
        await writeFile(
            join(userDataDir, 'Local State'),
            JSON.stringify({
                profile: {
                    info_cache: {
                        Default: { name: 'Personal' },
                        'Profile 2': { name: 'Work' },
                    },
                },
            })
        )

        expect(listLocalChromeProfiles(userDataDir)).toEqual([
            {
                directory: 'Default',
                name: 'Personal',
            },
            {
                directory: 'Profile 2',
                name: 'Work',
            },
        ])
    })
})
