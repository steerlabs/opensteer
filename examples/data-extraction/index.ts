import { Opensteer } from "../../src/index.js";
import "dotenv/config";

async function run() {
  const ov = new Opensteer({
    name: "product-extraction",
    model: "gpt-5.1",
  });

  await ov.launch({ headless: false });

  try {
    await ov.goto("https://kbdfans.com/search?q=linear+switches&type=product");

    console.log("Starting extraction...");
    const data = await ov.extract({
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
    await ov.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
