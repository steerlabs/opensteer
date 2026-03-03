import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

type ParseMode = 'help' | 'install' | 'error'

interface ParsedSkillsArgs {
    mode: ParseMode
    passthroughArgs: string[]
    error?: string
}

interface SkillsInstallInvocation {
    cliPath: string
    cliArgs: string[]
}

interface SkillsInstallerDeps {
    resolveSkillsCliPath: () => string
    resolveLocalSkillSourcePath: () => string
    spawnInvocation: (invocation: SkillsInstallInvocation) => Promise<number>
    writeStdout: (message: string) => void
    writeStderr: (message: string) => void
}

const HELP_TEXT = `Usage: opensteer skills <install|add> [options]

Installs the first-party Opensteer skill using the upstream "skills" CLI.

Commands:
  install                  Install the opensteer skill
  add                      Alias for install

Supported Options:
  -a, --agent <agents...>  Target specific agent(s)
  -g, --global             Install globally
  -y, --yes                Skip confirmations
  --copy                   Copy files instead of symlinking
  --all                    Install to all agents
  -h, --help               Show this help

Examples:
  opensteer skills install
  opensteer skills add --agent codex --global --yes
  opensteer skills install --all --yes
`

export function parseOpensteerSkillsArgs(rawArgs: string[]): ParsedSkillsArgs {
    if (rawArgs.length === 0) {
        return { mode: 'help', passthroughArgs: [] }
    }

    const [subcommand, ...rest] = rawArgs
    if (
        subcommand === 'help' ||
        subcommand === '--help' ||
        subcommand === '-h'
    ) {
        return { mode: 'help', passthroughArgs: [] }
    }

    if (subcommand !== 'install' && subcommand !== 'add') {
        return {
            mode: 'error',
            passthroughArgs: [],
            error: `Unsupported skills subcommand "${subcommand}". Use "install" or "add".`,
        }
    }

    const passthroughArgs: string[] = []

    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]
        if (arg === '--help' || arg === '-h') {
            return { mode: 'help', passthroughArgs: [] }
        }

        if (arg === '--global' || arg === '-g') {
            passthroughArgs.push(arg)
            continue
        }

        if (arg === '--yes' || arg === '-y') {
            passthroughArgs.push(arg)
            continue
        }

        if (arg === '--copy' || arg === '--all') {
            passthroughArgs.push(arg)
            continue
        }

        if (arg === '--agent' || arg === '-a') {
            passthroughArgs.push(arg)

            if (i + 1 >= rest.length || rest[i + 1]?.startsWith('-')) {
                return {
                    mode: 'error',
                    passthroughArgs: [],
                    error: `${arg} requires at least one value.`,
                }
            }

            while (i + 1 < rest.length && !rest[i + 1]?.startsWith('-')) {
                i += 1
                const agent = rest[i]
                if (agent) {
                    passthroughArgs.push(agent)
                }
            }
            continue
        }

        if (arg.startsWith('-')) {
            return {
                mode: 'error',
                passthroughArgs: [],
                error: `Unsupported option "${arg}" for "opensteer skills".`,
            }
        }

        return {
            mode: 'error',
            passthroughArgs: [],
            error: `Unexpected argument "${arg}".`,
        }
    }

    return {
        mode: 'install',
        passthroughArgs,
    }
}

export function resolveLocalSkillSourcePath(): string {
    const packageRoot = resolvePackageRoot()
    const sourcePath = join(packageRoot, 'skills')

    if (!existsSync(sourcePath)) {
        throw new Error(
            `Opensteer skill source was not found at "${sourcePath}".`
        )
    }

    return sourcePath
}

export function resolveSkillsCliPath(): string {
    const require = createRequire(resolveCliEntrypointPath())
    const skillsPackagePath = require.resolve('skills/package.json')
    const skillsPackageDir = dirname(skillsPackagePath)
    const cliPath = join(skillsPackageDir, 'bin', 'cli.mjs')

    if (!existsSync(cliPath)) {
        throw new Error(`skills CLI entrypoint was not found at "${cliPath}".`)
    }

    return cliPath
}

function resolveCliEntrypointPath(): string {
    const cliEntrypoint = process.argv[1]
    if (!cliEntrypoint) {
        throw new Error('Unable to resolve CLI entrypoint path for skills installer.')
    }
    return realpathSync(cliEntrypoint)
}

function resolvePackageRoot(): string {
    const cliEntrypointPath = resolveCliEntrypointPath()
    const binDir = dirname(cliEntrypointPath)
    return resolve(binDir, '..')
}

export function createSkillsInstallInvocation(args: {
    localSkillSourcePath: string
    passthroughArgs: string[]
    skillsCliPath: string
}): SkillsInstallInvocation {
    return {
        cliPath: args.skillsCliPath,
        cliArgs: [
            'add',
            args.localSkillSourcePath,
            '--skill',
            'opensteer',
            ...args.passthroughArgs,
        ],
    }
}

async function spawnInvocation(
    invocation: SkillsInstallInvocation
): Promise<number> {
    return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [invocation.cliPath, ...invocation.cliArgs], {
            stdio: 'inherit',
            env: process.env,
            cwd: process.cwd(),
        })

        child.once('error', (error) => {
            rejectPromise(error)
        })

        child.once('exit', (code) => {
            if (typeof code === 'number') {
                resolvePromise(code)
                return
            }

            resolvePromise(1)
        })
    })
}

function createDefaultDeps(): SkillsInstallerDeps {
    return {
        resolveSkillsCliPath,
        resolveLocalSkillSourcePath,
        spawnInvocation,
        writeStdout(message) {
            process.stdout.write(message)
        },
        writeStderr(message) {
            process.stderr.write(message)
        },
    }
}

export async function runOpensteerSkillsInstaller(
    rawArgs: string[],
    overrideDeps: Partial<SkillsInstallerDeps> = {}
): Promise<number> {
    const deps: SkillsInstallerDeps = {
        ...createDefaultDeps(),
        ...overrideDeps,
    }

    const parsed = parseOpensteerSkillsArgs(rawArgs)
    if (parsed.mode === 'help') {
        deps.writeStdout(HELP_TEXT)
        return 0
    }

    if (parsed.mode === 'error') {
        deps.writeStderr(`${parsed.error}\n`)
        deps.writeStderr('Run "opensteer skills --help" for usage.\n')
        return 1
    }

    const invocation = createSkillsInstallInvocation({
        localSkillSourcePath: deps.resolveLocalSkillSourcePath(),
        passthroughArgs: parsed.passthroughArgs,
        skillsCliPath: deps.resolveSkillsCliPath(),
    })

    return await deps.spawnInvocation(invocation)
}
