import { Opensteer } from '../../src/index.js'

async function run() {
    const opensteer = new Opensteer({ name: 'basic-usage' })
    await opensteer.launch({ headless: false })

    try {
        await opensteer.goto('https://example.com')

        const html = await opensteer.snapshot()
        console.log(html.slice(0, 500))

        await opensteer.click({
            element: 5,
            description: 'Click a prominent call-to-action',
        })
    } finally {
        await opensteer.close()
    }
}

run().catch((err) => {
    console.error(err)
    process.exit(1)
})
