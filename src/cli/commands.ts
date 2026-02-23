import { writeFile } from 'node:fs/promises'
import type { Opensteer } from '../opensteer.js'
import type { ExtractSchema, SnapshotMode } from '../types.js'

type CommandHandler = (
    opensteer: Opensteer,
    args: Record<string, unknown>
) => Promise<unknown>

const commands: Record<string, CommandHandler> = {
    async navigate(opensteer, args) {
        const url = args.url as string
        if (!url) throw new Error('Missing required argument: url')
        await opensteer.goto(url, {
            timeout: args.timeout as number | undefined,
            settleMs: args.settleMs as number | undefined,
            waitUntil: args.waitUntil as
                | 'commit'
                | 'domcontentloaded'
                | 'load'
                | 'networkidle'
                | undefined,
        })
        return { url: opensteer.page.url() }
    },

    async back(opensteer) {
        await opensteer.page.goBack()
        return { url: opensteer.page.url() }
    },

    async forward(opensteer) {
        await opensteer.page.goForward()
        return { url: opensteer.page.url() }
    },

    async reload(opensteer) {
        await opensteer.page.reload()
        return { url: opensteer.page.url() }
    },

    async snapshot(opensteer, args) {
        const mode = (args.mode as SnapshotMode) || 'action'
        const html = await opensteer.snapshot({ mode })
        return { html }
    },

    async state(opensteer) {
        return await opensteer.state()
    },

    async screenshot(opensteer, args) {
        const file = (args.file as string) || 'screenshot.png'
        const type = file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'jpeg' : 'png'
        const buffer = await opensteer.screenshot({
            fullPage: args.fullPage as boolean | undefined,
            type,
        })
        await writeFile(file, buffer)
        return { file }
    },

    async click(opensteer, args) {
        return await opensteer.click({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            button: args.button as 'left' | 'right' | 'middle' | undefined,
            clickCount: args.clickCount as number | undefined,
        })
    },

    async dblclick(opensteer, args) {
        return await opensteer.dblclick({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async rightclick(opensteer, args) {
        return await opensteer.rightclick({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async hover(opensteer, args) {
        return await opensteer.hover({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
    },

    async input(opensteer, args) {
        const text = args.text as string
        if (text == null) throw new Error('Missing required argument: text')
        return await opensteer.input({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            text,
            clear: args.clear as boolean | undefined,
            pressEnter: args.pressEnter as boolean | undefined,
        })
    },

    async select(opensteer, args) {
        return await opensteer.select({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
            value: args.value as string | undefined,
            label: args.label as string | undefined,
            index: args.index as number | undefined,
        })
    },

    async scroll(opensteer, args) {
        return await opensteer.scroll({
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

    async press(opensteer, args) {
        const key = args.key as string
        if (!key) throw new Error('Missing required argument: key')
        await opensteer.pressKey(key)
        return { key }
    },

    async type(opensteer, args) {
        const text = args.text as string
        if (text == null) throw new Error('Missing required argument: text')
        await opensteer.type(text)
        return { text }
    },

    async 'get-text'(opensteer, args) {
        const text = await opensteer.getElementText({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { text }
    },

    async 'get-value'(opensteer, args) {
        const value = await opensteer.getElementValue({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { value }
    },

    async 'get-attrs'(opensteer, args) {
        const attributes = await opensteer.getElementAttributes({
            element: args.element as number | undefined,
            selector: args.selector as string | undefined,
            description: args.description as string | undefined,
        })
        return { attributes }
    },

    async 'get-html'(opensteer, args) {
        const html = await opensteer.getHtml(args.selector as string | undefined)
        return { html }
    },

    async tabs(opensteer) {
        const tabs = await opensteer.tabs()
        return { tabs }
    },

    async 'tab-new'(opensteer, args) {
        return await opensteer.newTab(args.url as string | undefined)
    },

    async 'tab-switch'(opensteer, args) {
        const index = args.index as number
        if (index == null) throw new Error('Missing required argument: index')
        await opensteer.switchTab(index)
        return { index }
    },

    async 'tab-close'(opensteer, args) {
        await opensteer.closeTab(args.index as number | undefined)
        return {}
    },

    async cookies(opensteer, args) {
        const cookies = await opensteer.getCookies(args.url as string | undefined)
        return { cookies }
    },

    async 'cookie-set'(opensteer, args) {
        await opensteer.setCookie({
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

    async 'cookies-clear'(opensteer) {
        await opensteer.clearCookies()
        return {}
    },

    async 'cookies-export'(opensteer, args) {
        const file = args.file as string
        if (!file) throw new Error('Missing required argument: file')
        await opensteer.exportCookies(file, args.url as string | undefined)
        return { file }
    },

    async 'cookies-import'(opensteer, args) {
        const file = args.file as string
        if (!file) throw new Error('Missing required argument: file')
        await opensteer.importCookies(file)
        return { file }
    },

    async eval(opensteer, args) {
        const expression = args.expression as string
        if (!expression)
            throw new Error('Missing required argument: expression')
        const result = await opensteer.page.evaluate(expression)
        return { result }
    },

    async 'wait-for'(opensteer, args) {
        const text = args.text as string
        if (!text) throw new Error('Missing required argument: text')
        await opensteer.waitForText(text, {
            timeout: args.timeout as number | undefined,
        })
        return { text }
    },

    async 'wait-selector'(opensteer, args) {
        const selector = args.selector as string
        if (!selector) throw new Error('Missing required argument: selector')
        await opensteer.page.waitForSelector(selector, {
            timeout: (args.timeout as number) ?? 30000,
        })
        return { selector }
    },

    async extract(opensteer, args) {
        const schema = args.schema as ExtractSchema | undefined
        const data = await opensteer.extract({
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
