import type { Opensteer } from '../opensteer.js'
import type { ExtractSchema, SnapshotMode } from '../types.js'

type CommandHandler = (
    ov: Opensteer,
    args: Record<string, unknown>
) => Promise<unknown>

const commands: Record<string, CommandHandler> = {
    async navigate(ov, args) {
        const url = args.url as string
        if (!url) throw new Error('Missing required argument: url')
        await ov.goto(url, {
            timeout: args.timeout as number | undefined,
            settleMs: args.settleMs as number | undefined,
            waitUntil: args.waitUntil as
                | 'commit'
                | 'domcontentloaded'
                | 'load'
                | 'networkidle'
                | undefined,
        })
        return { url: ov.page.url() }
    },

    async back(ov) {
        await ov.page.goBack()
        return { url: ov.page.url() }
    },

    async forward(ov) {
        await ov.page.goForward()
        return { url: ov.page.url() }
    },

    async reload(ov) {
        await ov.page.reload()
        return { url: ov.page.url() }
    },

    async snapshot(ov, args) {
        const mode = (args.mode as SnapshotMode) || 'action'
        const html = await ov.snapshot({ mode })
        return { html }
    },

    async state(ov) {
        return await ov.state()
    },

    async screenshot(ov, args) {
        const file = (args.file as string) || 'screenshot.png'
        await ov.page.screenshot({
            path: file,
            fullPage: args.fullPage as boolean | undefined,
        })
        return { file }
    },

    async click(ov, args) {
        return await ov.click({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            button: args.button as 'left' | 'right' | 'middle' | undefined,
            clickCount: args.clickCount as number | undefined,
        })
    },

    async dblclick(ov, args) {
        return await ov.dblclick({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async rightclick(ov, args) {
        return await ov.rightclick({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async hover(ov, args) {
        return await ov.hover({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async input(ov, args) {
        const text = args.text as string
        if (text == null) throw new Error('Missing required argument: text')
        return await ov.input({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            text,
            clear: args.clear as boolean | undefined,
            pressEnter: args.pressEnter as boolean | undefined,
        })
    },

    async select(ov, args) {
        return await ov.select({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            value: args.value as string | undefined,
            label: args.label as string | undefined,
            index: args.index as number | undefined,
        })
    },

    async scroll(ov, args) {
        return await ov.scroll({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            direction: args.direction as
                | 'up'
                | 'down'
                | 'left'
                | 'right'
                | undefined,
            amount: args.amount as number | undefined,
        })
    },

    async press(ov, args) {
        const key = args.key as string
        if (!key) throw new Error('Missing required argument: key')
        await ov.pressKey(key)
        return { key }
    },

    async type(ov, args) {
        const text = args.text as string
        if (text == null) throw new Error('Missing required argument: text')
        await ov.type(text)
        return { text }
    },

    async 'get-text'(ov, args) {
        const text = await ov.getElementText({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { text }
    },

    async 'get-value'(ov, args) {
        const value = await ov.getElementValue({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { value }
    },

    async 'get-attrs'(ov, args) {
        const attributes = await ov.getElementAttributes({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { attributes }
    },

    async 'get-html'(ov, args) {
        const html = await ov.getHtml(args.selector as string | undefined)
        return { html }
    },

    async tabs(ov) {
        const tabs = await ov.tabs()
        return { tabs }
    },

    async 'tab-new'(ov, args) {
        return await ov.newTab(args.url as string | undefined)
    },

    async 'tab-switch'(ov, args) {
        const index = args.index as number
        if (index == null) throw new Error('Missing required argument: index')
        await ov.switchTab(index)
        return { index }
    },

    async 'tab-close'(ov, args) {
        await ov.closeTab(args.index as number | undefined)
        return {}
    },

    async cookies(ov, args) {
        const cookies = await ov.getCookies(args.url as string | undefined)
        return { cookies }
    },

    async 'cookie-set'(ov, args) {
        await ov.setCookie({
            name: args.name as string,
            value: args.value as string,
            url: args.url as string | undefined,
            domain: args.domain as string | undefined,
            path: args.path as string | undefined,
            expires: args.expires as number | undefined,
            httpOnly: args.httpOnly as boolean | undefined,
            secure: args.secure as boolean | undefined,
            sameSite: args.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
        })
        return {}
    },

    async 'cookies-clear'(ov) {
        await ov.clearCookies()
        return {}
    },

    async 'cookies-export'(ov, args) {
        const file = args.file as string
        if (!file) throw new Error('Missing required argument: file')
        await ov.exportCookies(file, args.url as string | undefined)
        return { file }
    },

    async 'cookies-import'(ov, args) {
        const file = args.file as string
        if (!file) throw new Error('Missing required argument: file')
        await ov.importCookies(file)
        return { file }
    },

    async eval(ov, args) {
        const expression = args.expression as string
        if (!expression)
            throw new Error('Missing required argument: expression')
        const result = await ov.page.evaluate(expression)
        return { result }
    },

    async 'wait-for'(ov, args) {
        const text = args.text as string
        if (!text) throw new Error('Missing required argument: text')
        await ov.waitForText(text, {
            timeout: args.timeout as number | undefined,
        })
        return { text }
    },

    async 'wait-selector'(ov, args) {
        const selector = args.selector as string
        if (!selector) throw new Error('Missing required argument: selector')
        await ov.page.waitForSelector(selector, {
            timeout: (args.timeout as number) ?? 30000,
        })
        return { selector }
    },

    async extract(ov, args) {
        const schema = args.schema as ExtractSchema | undefined
        const data = await ov.extract({
            schema,
            description: args.description as string | undefined,
            prompt: args.prompt as string | undefined,
        })
        return { data }
    },
}

export function getCommandHandler(name: string): CommandHandler | undefined {
    return commands[name]
}

export function listCommandNames(): string[] {
    return Object.keys(commands)
}
