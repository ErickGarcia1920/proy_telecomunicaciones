const registrationForm = document.querySelector("#registration-form");
const paymentStep = document.querySelector("#payment-step");
const packageSummary = document.querySelector("#package-summary");
const registerButton = document.querySelector("#register-button");
const payButton = document.querySelector("#pay-button");
const message = document.querySelector("#message");

let currentSessionId = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.dataset.error = String(isError);
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "No fue posible completar la solicitud.");
  }
  return result;
}

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registerButton.disabled = true;
  showMessage("");

  const formData = new FormData(registrationForm);
  try {
    const result = await requestJson("/api/register", {
      name: formData.get("name"),
      email: formData.get("email"),
      packageId: formData.get("packageId"),
      acceptedTerms: formData.get("acceptedTerms") === "on",
    });
    currentSessionId = result.session.id;
    packageSummary.textContent =
      `${result.session.package.name} · Q${result.session.package.price} (precio ilustrativo; no se cobra)`;
    paymentStep.hidden = false;
    registrationForm.querySelectorAll("input, select, button").forEach((field) => {
      field.disabled = true;
    });
    showMessage(result.message);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    if (!currentSessionId) registerButton.disabled = false;
  }
});

payButton.addEventListener("click", async () => {
  if (!currentSessionId) {
    showMessage("Completa primero el registro.", true);
    return;
  }

  payButton.disabled = true;
  showMessage("");
  try {
    const result = await requestJson("/api/payments/mock", { sessionId: currentSessionId });
    showMessage(result.message);
    payButton.textContent = "Pago de demostración completado";
  } catch (error) {
    showMessage(error.message, true);
    payButton.disabled = false;
  }
});
