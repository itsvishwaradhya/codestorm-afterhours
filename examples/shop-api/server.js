const express = require("express");
const { products, findProduct, cartTotal } = require("./catalog");

const app = express();
const port = Number(process.env.PORT || 3000);

app.get("/", (_req, res) => {
  res.json({ service: "shop-api", status: "ok" });
});

app.get("/products", (_req, res) => {
  res.json(products.map(({ id, name, price }) => ({ id, name, price })));
});

app.get("/products/2", (_req, res) => {
  const product = findProduct(2);
  res.json({ ...product, inStock: product.stock > 0 });
});

app.get("/cart", (_req, res) => {
  const items = [
    { id: 1, qty: 2 },
    { id: 3, qty: 1 },
  ];
  res.json({ items, total: cartTotal(items) });
});

app.listen(port, () => {
  console.log(`shop-api listening on http://localhost:${port}`);
});
