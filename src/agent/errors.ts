export class OpensteerAgentError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, { cause })
        this.name = 'OpensteerAgentError'
    }
}

export class OpensteerAgentConfigError extends OpensteerAgentError {
    constructor(message: string) {
        super(message)
        this.name = 'OpensteerAgentConfigError'
    }
}

export class OpensteerAgentProviderError extends OpensteerAgentError {
    constructor(message: string) {
        super(message)
        this.name = 'OpensteerAgentProviderError'
    }
}

export class OpensteerAgentExecutionError extends OpensteerAgentError {
    constructor(message: string, cause?: unknown) {
        super(message, cause)
        this.name = 'OpensteerAgentExecutionError'
    }
}

export class OpensteerAgentBusyError extends OpensteerAgentError {
    constructor() {
        super('An OpenSteer agent execution is already in progress on this instance.')
        this.name = 'OpensteerAgentBusyError'
    }
}

export class OpensteerAgentActionError extends OpensteerAgentError {
    constructor(message: string, cause?: unknown) {
        super(message, cause)
        this.name = 'OpensteerAgentActionError'
    }
}

export class OpensteerAgentApiError extends OpensteerAgentError {
    readonly status?: number
    readonly provider: string

    constructor(provider: string, message: string, status?: number, cause?: unknown) {
        super(message, cause)
        this.name = 'OpensteerAgentApiError'
        this.provider = provider
        this.status = status
    }
}
