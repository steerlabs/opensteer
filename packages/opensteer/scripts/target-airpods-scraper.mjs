import { Opensteer } from "opensteer";

const EXTRACT_SCHEMA = {
  searchTerm: { element: 19 },
  results: [
    {
      title: { element: 58 },
      titleUrl: { element: 57, attribute: "href" },
      price: { element: 54 },
      shipping: { element: 68 },
      imageUrl: { element: 52, attribute: "src" },
    },
    {
      title: { element: 78 },
      titleUrl: { element: 77, attribute: "href" },
      price: { element: 75 },
      shipping: { element: 88 },
      imageUrl: { element: 73, attribute: "src" },
    },
  ],
};

async function run() {
  const opensteer = new Opensteer({
    name: "target-airpods-cachetest",
    rootDir: process.cwd(),
    browser: {
      headless: false,
    },
  });

  try {
    await opensteer.open("https://www.target.com");
    await opensteer.snapshot("action");

    await opensteer.input({
      element: 30,
      description: "target search input",
      text: "airpods",
      pressEnter: true,
    });
    await opensteer.snapshot("action");

    const data = await opensteer.extract({
      description: "target airpods search results",
      schema: EXTRACT_SCHEMA,
    });

    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
