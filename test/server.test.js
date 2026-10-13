const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("../server");

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function postJson(route, data) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { response, body: await response.json() };
}

test("sirve el portal web", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Conéctate a tu manera/);
});

test("registra un usuario y cambia su estado solo tras simular el pago", async () => {
  const registration = await postJson("/api/register", {
    name: "Ana López",
    email: "ana@example.com",
    packageId: "day",
    acceptedTerms: true,
  });

  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.session.status, "registered");
  assert.equal(registration.body.session.package.price, 15);

  const payment = await postJson("/api/payments/mock", {
    sessionId: registration.body.session.id,
  });
  assert.equal(payment.response.status, 200);
  assert.equal(payment.body.session.status, "payment_simulated");
  assert.match(payment.body.message, /no habilita el firewall/);

  const status = await fetch(`${baseUrl}/api/sessions/${registration.body.session.id}`);
  assert.equal((await status.json()).session.status, "payment_simulated");
});

test("rechaza registro inválido y pagos duplicados", async () => {
  const invalid = await postJson("/api/register", {
    name: "A",
    email: "correo-invalido",
    packageId: "day",
    acceptedTerms: true,
  });
  assert.equal(invalid.response.status, 400);

  const registration = await postJson("/api/register", {
    name: "Luis Pérez",
    email: "luis@example.com",
    packageId: "hour",
    acceptedTerms: true,
  });
  const paymentData = { sessionId: registration.body.session.id };
  await postJson("/api/payments/mock", paymentData);
  const duplicate = await postJson("/api/payments/mock", paymentData);
  assert.equal(duplicate.response.status, 409);
});
