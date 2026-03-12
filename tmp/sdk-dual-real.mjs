import { Opensteer } from '../dist/index.js'

async function runOne(label, url) {
  const opensteer = new Opensteer({
    name: `sdk-${label}`,
    browser: {
      mode: 'real',
      headless: true,
    },
  })

  try {
    await opensteer.launch({
      mode: 'real',
      headless: true,
      initialUrl: url,
    })

    const state = await opensteer.state()
    return {
      label,
      expectedUrl: url,
      actualUrl: state.url,
      title: state.title,
      stateOk: Boolean(state.title?.length),
    }
  } finally {
    await opensteer.close().catch(() => undefined)
  }
}

const start = Date.now()
const results = await Promise.all([
  runOne('alpha', 'https://example.com/'),
  runOne('beta', 'https://example.org/'),
])

console.log(
  JSON.stringify(
    {
      ok: true,
      parallelMs: Date.now() - start,
      results,
    },
    null,
    2,
  ),
)
