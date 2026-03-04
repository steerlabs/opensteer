import { Opensteer } from '../../src/index.js'

async function run() {
    const opensteer = new Opensteer({
        name: 'contact-form',
        model: 'gpt-5-mini',
    })
    await opensteer.launch({ headless: false })

    try {
        await opensteer.goto('https://www.w3schools.com/html/html_forms.asp')

        await opensteer.input({
            text: 'Ada Lovelace',
            description: 'Fill first name',
        })

        await opensteer.input({
            text: 'Lovelace',
            description: 'Fill in last name',
        })
        await opensteer.click({
            description: 'Submit the form',
        })
    } finally {
        await opensteer.close()
    }
}

run().catch((error) => {
    console.error('Example failed.', error)
    process.exit(1)
})
