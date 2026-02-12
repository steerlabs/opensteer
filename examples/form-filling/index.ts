import { Opensteer } from '../../src/index.js'
import 'dotenv/config'

async function run() {
    const ov = new Opensteer({
        name: 'contact-form',
        model: 'gpt-5-mini',
    })
    await ov.launch({ headless: false })

    try {
        await ov.goto('https://www.w3schools.com/html/html_forms.asp')

        await ov.input({
            text: 'Ada Lovelace',
            description: 'Fill first name',
        })

        await ov.input({
            text: 'Lovelace',
            description: 'Fill in last name',
        })
        await ov.click({
            description: 'Submit the form',
        })
    } finally {
        await ov.close()
    }
}

run().catch((err) => {
    console.error(err)
    process.exit(1)
})
