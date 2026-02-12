import { Oversteer } from '../../src/index.js'
import 'dotenv/config'

async function run() {
    const ov = new Oversteer({
        name: 'product-extraction',
        model: 'gpt-5.1',
    })

    await ov.launch({ headless: false })

    try {
        await ov.goto('https://www.target.com/s?searchTerm=apple+pie')

        console.log('Starting extraction...')
        const data = await ov.extract({
            description:
                'Extract the main product cards with title, price, image url, and review rating',
            schema: {
                products: [
                    {
                        title: '',
                        price: '',
                        imageUrl: '',
                        reviewRating: '',
                    },
                ],
            },
        })

        console.log(data)
    } finally {
        await ov.close()
    }
}

run().catch((err) => {
    console.error(err)
    process.exit(1)
})
