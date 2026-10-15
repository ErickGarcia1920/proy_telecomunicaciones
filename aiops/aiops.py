#!/usr/bin/env python3
"""
AIOps: detección de comportamientos anómalos en los logs de pfSense.

Flujo:
  1. pfSense envía sus logs de firewall (filterlog) por syslog UDP a esta VM.
  2. Cada línea se convierte en una conexión: origen, destino, puerto, pass/block.
  3. Por cada minuto y por cada IP de origen se calculan 3 variables:
       - total de conexiones
       - conexiones bloqueadas
       - puertos destino distintos
  4. Un modelo Isolation Forest aprende el comportamiento normal y marca como
     anómalo lo que se aleja de él (por ejemplo, un escaneo de puertos).

Uso:
  python aiops.py demo                      Prueba completa sin pfSense (datos simulados)
  python aiops.py live --port 514           Escucha syslog real de pfSense
  python aiops.py live --port 5514 --train-minutes 2     (prueba rápida)
"""
import argparse
import json
import random
import re
import socket
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta

import numpy as np
from sklearn.ensemble import IsolationForest

FEATURES = ["total", "blocked", "ports"]
ALERT_FILE = "aiops_alerts.jsonl"
MIN_TRAIN_ROWS = 20


# --------------------------------------------------------------------------
# 1. Lectura de logs: filterlog de pfSense
# --------------------------------------------------------------------------
def parse_filterlog(line):
    """Convierte una línea de syslog de pfSense en un dict, o None si no aplica.

    Campos de filterlog (CSV): regla,subregla,ancla,tracker,interfaz,razón,
    acción,dirección,versión IP, ... Para IPv4: protocolo texto en [16], origen
    en [18], destino en [19], puertos en [20] y [21]. Para IPv6: protocolo texto
    en [12], origen en [15], destino en [16], puertos en [17] y [18].
    """
    m = re.search(r"filterlog(?:\[\d+\])?:?\s*(?:-\s+-\s+)?(.*)$", line)
    if not m:
        return None
    f = m.group(1).strip().split(",")
    try:
        action = f[6]
        version = f[8]
        if version == "4":
            proto, src, dst = f[16], f[18], f[19]
            dport = int(f[21]) if proto in ("tcp", "udp") and len(f) > 21 else 0
        elif version == "6":
            proto, src, dst = f[12], f[15], f[16]
            dport = int(f[18]) if proto in ("tcp", "udp") and len(f) > 18 else 0
        else:
            return None
    except (IndexError, ValueError):
        return None
    return {"src": src, "dst": dst, "dport": dport, "proto": proto,
            "blocked": action == "block"}


# --------------------------------------------------------------------------
# 2. Variables por minuto y por IP de origen
# --------------------------------------------------------------------------
class Aggregator:
    def __init__(self):
        self.buckets = defaultdict(lambda: {"total": 0, "blocked": 0, "ports": set()})

    def add(self, minute, ev):
        b = self.buckets[(minute, ev["src"])]
        b["total"] += 1
        b["blocked"] += 1 if ev["blocked"] else 0
        b["ports"].add(ev["dport"])

    def pop_before(self, minute):
        """Saca y devuelve los minutos ya cerrados (anteriores a `minute`)."""
        rows = []
        for key in [k for k in self.buckets if k[0] < minute]:
            b = self.buckets.pop(key)
            rows.append({"minute": key[0], "src": key[1], "total": b["total"],
                         "blocked": b["blocked"], "ports": len(b["ports"])})
        return rows


def to_matrix(rows):
    return np.array([[r[k] for k in FEATURES] for r in rows], dtype=float)


# --------------------------------------------------------------------------
# 3. Modelo
# --------------------------------------------------------------------------
class Detector:
    """Isolation Forest + regla de refuerzo.

    Isolation Forest no extrapola: un valor muy por encima de todo lo visto en
    el entrenamiento queda apenas "en el borde" y puede no marcarse. Por eso,
    además del modelo, se alerta si alguna variable supera EXCESO veces el
    máximo observado durante el aprendizaje.
    """
    EXCESO = 2.0

    def __init__(self):
        self.model = None
        self.maximos = None

    def train(self, rows):
        X = to_matrix(rows)
        self.model = IsolationForest(n_estimators=200, contamination=0.01,
                                     random_state=42)
        self.model.fit(X)
        self.maximos = X.max(axis=0)

    def score(self, rows):
        """Devuelve (fila, puntaje) de las filas anómalas. Menor puntaje = más raro."""
        if not rows:
            return []
        X = to_matrix(rows)
        pred = self.model.predict(X)
        scores = self.model.decision_function(X)
        out = []
        for r, p, s, x in zip(rows, pred, scores, X):
            # Se exige actividad mínima para no alertar por una sola conexión suelta.
            if r["total"] < 5:
                fuera_de_rango = False
            else:
                fuera_de_rango = bool(np.any(x > self.EXCESO * np.maximum(self.maximos, 1)))
            if r["total"] >= 5 and (p == -1 or fuera_de_rango):
                out.append((r, float(min(s, -0.0001)) if fuera_de_rango else float(s)))
        return out


def raise_alert(row, score):
    when = datetime.fromtimestamp(row["minute"] * 60).strftime("%Y-%m-%d %H:%M")
    reason = []
    if row["ports"] >= 15:
        reason.append(f"{row['ports']} puertos distintos (posible escaneo de puertos)")
    if row["total"] > 0 and row["blocked"] / row["total"] > 0.5:
        reason.append(f"{row['blocked']} de {row['total']} conexiones bloqueadas")
    if not reason:
        reason.append("patrón fuera de lo normal")
    msg = {"hora": when, "origen": row["src"], "conexiones": row["total"],
           "bloqueadas": row["blocked"], "puertos_distintos": row["ports"],
           "puntaje": round(score, 4), "motivo": "; ".join(reason)}
    print(f"[ALERTA] {when}  origen={row['src']}  conexiones={row['total']}  "
          f"bloqueadas={row['blocked']}  puertos={row['ports']}  -> {msg['motivo']}")
    with open(ALERT_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(msg, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------
# 4. Modo demo: genera logs simulados en formato filterlog y los procesa
# --------------------------------------------------------------------------
def fake_line(ts, src, dst, dport, blocked):
    iso = ts.strftime("%Y-%m-%dT%H:%M:%S-06:00")
    act = "block" if blocked else "pass"
    return (f"<134>1 {iso} pfSense.localdomain filterlog 4321 - - "
            f"5,,,1000000103,em1,match,{act},in,4,0x0,,64,1234,0,none,6,tcp,60,"
            f"{src},{dst},50000,{dport},0,S,123456,,64240,,mss")


def make_normal_logs(minutes=90, seed=7):
    random.seed(seed)
    start = datetime(2026, 10, 15, 8, 0, 0)
    clients = [f"10.10.20.{i}" for i in range(10, 20)]
    common = [80, 443, 443, 443, 53, 8080, 993]
    lines = []
    for m in range(minutes):
        for c in clients:
            for _ in range(random.randint(3, 14)):
                ts = start + timedelta(minutes=m, seconds=random.randint(0, 59))
                dport = random.choice(common)
                lines.append((ts, fake_line(ts, c, "142.250.0.1", dport,
                                            random.random() < 0.03)))
    return start, lines


def make_scan_logs(start, minute_offset, attacker="10.10.20.99"):
    base = start + timedelta(minutes=minute_offset)
    lines = []
    for i in range(120):
        ts = base + timedelta(seconds=i // 3)
        lines.append((ts, fake_line(ts, attacker, "10.10.30.10", 20 + i, True)))
    return lines


def run_demo():
    print("== DEMO AIOps: entrenamiento con tráfico normal y detección de un escaneo ==\n")
    start, normal = make_normal_logs()
    agg = Aggregator()
    for ts, line in normal:
        ev = parse_filterlog(line)
        if ev:
            agg.add(int(ts.timestamp() // 60), ev)
    rows = agg.pop_before(10**12)
    print(f"Líneas de log leídas: {len(normal)}")
    print(f"Muestras de entrenamiento (minuto x IP): {len(rows)}")

    det = Detector()
    det.train(rows)
    print("Modelo Isolation Forest entrenado.\n")

    false_pos = det.score(rows)
    print(f"Falsas alarmas sobre el tráfico normal: {len(false_pos)} de {len(rows)}\n")

    print("Simulando un escaneo de puertos desde 10.10.20.99 ...")
    scan = make_scan_logs(start, minute_offset=95)
    agg2 = Aggregator()
    for ts, line in scan:
        ev = parse_filterlog(line)
        if ev:
            agg2.add(int(ts.timestamp() // 60), ev)
    # Un cliente normal en el mismo periodo, para comparar.
    normal_now = [(start + timedelta(minutes=95, seconds=s),
                   fake_line(start, "10.10.20.12", "142.250.0.1", 443, False))
                  for s in range(0, 50, 5)]
    for ts, line in normal_now:
        agg2.add(int(ts.timestamp() // 60), parse_filterlog(line))
    alerts = det.score(agg2.pop_before(10**12))
    if alerts:
        for row, score in alerts:
            raise_alert(row, score)
    else:
        print("No se detectó nada (revisar el modelo).")
    print(f"\nAlertas guardadas en {ALERT_FILE}")


# --------------------------------------------------------------------------
# 5. Modo live: escucha syslog UDP de pfSense
# --------------------------------------------------------------------------
def run_live(host, port, train_minutes):
    sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET,
                         socket.SOCK_DGRAM)
    sock.bind((host, port))
    sock.settimeout(1.0)
    print(f"Escuchando syslog UDP en {host}:{port}")
    print(f"Fase de aprendizaje: {train_minutes} minutos de tráfico normal.\n")

    agg, det = Aggregator(), Detector()
    baseline = []
    started = time.time()
    trained = False
    while True:
        try:
            data, _ = sock.recvfrom(8192)
            ev = parse_filterlog(data.decode("utf-8", errors="replace"))
            if ev:
                agg.add(int(time.time() // 60), ev)
        except socket.timeout:
            pass
        except KeyboardInterrupt:
            print("\nCerrando.")
            return

        closed = agg.pop_before(int(time.time() // 60))
        if not closed:
            continue
        if not trained:
            baseline.extend(closed)
            elapsed = (time.time() - started) / 60
            if elapsed >= train_minutes and len(baseline) >= MIN_TRAIN_ROWS:
                det.train(baseline)
                trained = True
                print(f"Modelo entrenado con {len(baseline)} muestras. Vigilando...\n")
            elif elapsed >= train_minutes:
                print(f"Aún hay pocas muestras ({len(baseline)}/{MIN_TRAIN_ROWS}); sigo aprendiendo.")
        else:
            for row, score in det.score(closed):
                raise_alert(row, score)


def main():
    ap = argparse.ArgumentParser(description="AIOps para logs de pfSense")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("demo", help="prueba con datos simulados")
    lv = sub.add_parser("live", help="escuchar syslog real")
    lv.add_argument("--host", default="0.0.0.0")
    lv.add_argument("--port", type=int, default=514)
    lv.add_argument("--train-minutes", type=int, default=60)
    args = ap.parse_args()
    if args.cmd == "demo":
        run_demo()
    else:
        run_live(args.host, args.port, args.train_minutes)


if __name__ == "__main__":
    sys.exit(main())
