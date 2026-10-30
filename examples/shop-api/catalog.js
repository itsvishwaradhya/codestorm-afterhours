const products = [
  { id: 1, name: "Coffee beans", price: 12.5, stock: 40 },
  { id: 2, name: "Pour-over kettle", price: 49, stock: 6 },
  { id: 3, name: "Paper filters", price: 4.25, stock: 120 },
];

function findProduct(id) {
  return products.find((product) => product.id === id);
}

function cartTotal(items) {
  return items.reduce((sum, item) => sum + findProduct(item.id).price * item.qty, 0);
}

module.exports = { products, findProduct, cartTotal };
