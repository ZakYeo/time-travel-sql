CREATE TABLE inventory (
  sku text PRIMARY KEY,
  stock integer NOT NULL,
  "unitPrice" integer NOT NULL
);
CREATE TABLE orders (
  id text PRIMARY KEY,
  total integer NOT NULL
);
CREATE TABLE line_items (
  id text PRIMARY KEY,
  "orderId" text NOT NULL REFERENCES orders(id),
  sku text NOT NULL REFERENCES inventory(sku),
  quantity integer NOT NULL,
  "unitPrice" integer NOT NULL
);
