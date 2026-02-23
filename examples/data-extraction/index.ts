import { Opensteer } from "../../src/index.js";
import "dotenv/config";

async function run() {
  const opensteer = new Opensteer({
    name: "product-extraction",
    model: "gpt-5.1",
  });

  await opensteer.launch({ headless: false });

  try {
    await opensteer.goto(
      "https://kbdfans.com/search?type=product%2Cquery&options%5Bprefix%5D=last&q=tactile+switches",
    );

    console.log("Starting extraction...");
    const data = await opensteer.extract({
      description:
        "Extract the main product cards with title, price, image url, and url",
      schema: {
        products: [
          {
            title: "",
            price: "",
            imageUrl: "",
            url: "",
          },
        ],
      },
    });

    console.log(data);
  } finally {
    await opensteer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
