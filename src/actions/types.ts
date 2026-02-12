import type { ElementPath } from '../element-path/types.js'

export interface ActionExecutionResult {
    ok: boolean
    path?: ElementPath
    usedSelector?: string
    error?: string
}
