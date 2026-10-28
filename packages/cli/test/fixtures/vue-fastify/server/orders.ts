import { createInventory } from "./inventory";

export const placeOrder = (inventory = createInventory()) =>
  inventory.available() > 0 ? 201 : 409;
