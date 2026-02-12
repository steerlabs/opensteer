import { Oversteer } from '../../src/index.js'

async function run() {
    const ov = new Oversteer({ name: 'basic-usage' })
    await ov.launch({ headless: false })

    try {
        await ov.goto('https://example.com')

        const html = await ov.snapshot()
        console.log(html.slice(0, 500))

        await ov.click({
            element: 5,
            description: 'Click a prominent call-to-action',
        })
    } finally {
        await ov.close()
    }
}

run().catch((err) => {
    console.error(err)
    process.exit(1)
})
