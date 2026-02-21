import type { ElementPath } from '../element-path/types.js'
import type { ActionFailure } from '../action-failure.js'

export interface ActionExecutionResult {
    ok: boolean
    path?: ElementPath
    usedSelector?: string
    error?: string
    failure?: ActionFailure
}
