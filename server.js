const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 16 * 1024;
const PACKAGES = {
  hour: { name: "1 hora", price: 5 },
  day: { name: "1 día", price: 15 },
  week: { name: "1 semana", price: 50 },
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let tooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("La solicitud excede el tamaño permitido."), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("El cuerpo debe ser JSON válido."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function serveStatic(request, response, pathname) {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Solicitud inválida.");
    return;
  }

  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end("Acceso denegado.");
    return;
  }

  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };

  require("node:fs").readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("No se pudo cargar el recurso.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(contents);
  });
}

function createServer() {
  const sessions = new Map();

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");

    if (request.method === "POST" && requestUrl.pathname === "/api/register") {
      try {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const packageId = body.packageId;

        if (name.length < 2 || name.length > 80) {
          sendJson(response, 400, { error: "Ingresa un nombre de entre 2 y 80 caracteres." });
          return;
        }
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(response, 400, { error: "Ingresa un correo electrónico válido." });
          return;
        }
        if (!Object.hasOwn(PACKAGES, packageId)) {
          sendJson(response, 400, { error: "Selecciona un paquete válido." });
          return;
        }
        if (body.acceptedTerms !== true) {
          sendJson(response, 400, { error: "Debes aceptar las condiciones de la demostración." });
          return;
        }

        const id = randomUUID();
        const session = {
          id,
          name,
          email,
          packageId,
          status: "registered",
          createdAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        sendJson(response, 201, {
          session: { ...session, package: PACKAGES[packageId] },
          message: "Registro completado. Aún no hay acceso a Internet.",
        });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/payments/mock") {
      try {
        const body = await readJson(request);
        const session = sessions.get(body.sessionId);
        if (!session) {
          sendJson(response, 404, { error: "No se encontró el registro de esta sesión." });
          return;
        }
        if (session.status !== "registered") {
          sendJson(response, 409, { error: "El pago simulado ya fue procesado." });
          return;
        }

        session.status = "payment_simulated";
        session.paymentSimulatedAt = new Date().toISOString();
        sendJson(response, 200, {
          session: { ...session, package: PACKAGES[session.packageId] },
          message: "Pago simulado aprobado. Esto no habilita el firewall ni proporciona Internet.",
        });
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    const statusMatch = requestUrl.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/i);
    if (request.method === "GET" && statusMatch) {
      const session = sessions.get(statusMatch[1]);
      if (!session) {
        sendJson(response, 404, { error: "No se encontró el registro de esta sesión." });
        return;
      }
      sendJson(response, 200, {
        session: { ...session, package: PACKAGES[session.packageId] },
      });
      return;
    }

    if (request.method === "GET" && !requestUrl.pathname.startsWith("/api/")) {
      serveStatic(request, response, requestUrl.pathname);
      return;
    }

    sendJson(response, 404, { error: "Ruta no encontrada." });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  createServer().listen(port, host, () => {
    console.log(`Portal de demostración disponible en http://${host}:${port}`);
    console.log("Modo académico: no procesa pagos reales ni habilita pfSense.");
  });
}

module.exports = { createServer };
