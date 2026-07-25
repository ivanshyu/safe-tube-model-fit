#!/usr/bin/env python3
"""
ExtractModel-Safe: Vacuum Tube Fitting Engine & Transient-Safe SPICE Generator

A robust parameter extraction and SPICE subcircuit generator for vacuum tubes 
(Triodes, Pentodes, Beam Tetrodes) based on Derk Reefman's ExtractModel V4 theory.

Key Features & Transient Safety Protections:
  1. Singularity-free effective voltage regularizer: Va_eff = 0.5 * (Va + sqrt(Va^2 + 0.01))
     eliminates the -1/beta denominator pole during cold-start startup transients (Va < 0).
  2. ngspice 46 compatibility: Replaces IF() syntax and non-clamping LIMIT(x,a,b) with 
     exact numerical MIN(MAX(x, a), b) clamping.
  3. Newton-Raphson NaN defense: Inlines smooth-positive protection directly inside PWR()
     and PWR(1.5) to prevent intermediate negative iteration values from generating NaNs.
  4. Fully inlined safe denominators in G1/G2 current sources, eliminating intermediate 
     node zero-crossing risks.
  5. Multi-start Log-Space Nelder-Mead Optimization: Solves 20-order-of-magnitude parameter 
     scaling to consistently achieve global minimum fitting loss.
"""

import argparse
import math
import sys
import time
from pathlib import Path


def parse_utd_data(utd_text: str):
    rows = []
    for line in utd_text.strip().splitlines():
        parts = line.split()
        if len(parts) == 8 and parts[0].isdigit():
            ia = float(parts[2])   # Anode current (mA)
            is_ = float(parts[3])  # Screen current (mA)
            vg = float(parts[4])   # Control grid Vg1 (V)
            va = float(parts[5])   # Anode voltage Va (V)
            vs = float(parts[6])   # Screen voltage Vg2 (V)
            rows.append((ia, is_, vg, va, vs))
    return rows


# ----------------------------------------------------------------------
# 1. Koren Triode Model
# ----------------------------------------------------------------------
def koren_triode_ia(va: float, vg: float, mu: float, ex: float, kg1: float, kp: float, kvb: float) -> float:
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kp <= 0 or kvb <= 0:
        return 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + va * va))
    arg = max(-50.0, min(50.0, arg))
    e1 = (va / kp) * math.log(1.0 + math.exp(arg))
    if e1 > 0:
        return 1000.0 * (e1 ** ex) / kg1
    return 0.0


# ----------------------------------------------------------------------
# 2. Derk Pentode Model (Standard / Safe)
# ----------------------------------------------------------------------
def derk_pentode_ia_is(va: float, vs: float, vg: float,
                       mu: float, ex: float, kg1: float, kg2: float, kp: float, kvb: float,
                       A: float, alpha_s: float, beta: float, safe: bool = True) -> tuple[float, float]:
    if safe:
        va_eff = 0.5 * (va + math.sqrt(va * va + 0.01))
        vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01))
    else:
        va_eff = va
        vs_eff = vs

    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0:
        return 0.0, 0.0

    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0:
        return 0.0, 0.0

    ip_koren = 1000.0 * (e1 ** ex)
    alpha = max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s))

    denom = 1.0 + beta * va_eff
    if abs(denom) < 1e-9:
        return 0.0, 0.0

    is_pred = (ip_koren / kg2) * (1.0 + alpha_s / denom)
    term1 = (1.0 / kg1) - (1.0 / kg2)
    term2 = (A * va_eff) / kg1
    term3 = (1.0 / denom) * (alpha / kg1 + alpha_s / kg2)
    ia_pred = ip_koren * (term1 + term2 - term3)

    if safe and va < 0:
        cutoff = math.exp((va - math.sqrt(va * va + 1e-4)) / 4.0)
        ia_pred *= cutoff
        is_pred *= cutoff

    return max(0.0, ia_pred), max(0.0, is_pred)


# ----------------------------------------------------------------------
# 3. DerkE Pentode Model (Exponential Knee)
# ----------------------------------------------------------------------
def derke_pentode_ia_is(va: float, vs: float, vg: float,
                        mu: float, ex: float, kg1: float, kg2: float, kp: float, kvb: float,
                        A: float, alpha_s: float, beta: float, safe: bool = True) -> tuple[float, float]:
    if safe:
        va_eff = 0.5 * (va + math.sqrt(va * va + 0.01))
        vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01))
    else:
        va_eff = va
        vs_eff = vs

    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0:
        return 0.0, 0.0

    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0:
        return 0.0, 0.0

    ip_koren = 1000.0 * (e1 ** ex)
    alpha = max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s))

    exp_term = math.exp(-((beta * va_eff) ** 1.5)) if beta * va_eff >= 0 else 1.0

    is_pred = (ip_koren / kg2) * (1.0 + alpha_s * exp_term)
    term1 = (1.0 / kg1) - (1.0 / kg2)
    term2 = (A * va_eff) / kg1
    term3 = exp_term * (alpha / kg1 + alpha_s / kg2)
    ia_pred = ip_koren * (term1 + term2 - term3)

    if safe and va < 0:
        cutoff = math.exp((va - math.sqrt(va * va + 1e-4)) / 4.0)
        ia_pred *= cutoff
        is_pred *= cutoff

    return max(0.0, ia_pred), max(0.0, is_pred)


# ----------------------------------------------------------------------
# 4. Derk-SE Model (Secondary Emission Branch with Dimensionless E2 Factor)
# ----------------------------------------------------------------------
def derk_se_pentode_ia_is(va: float, vs: float, vg: float,
                          mu: float, ex: float, kg1: float, kg2: float, kp: float, kvb: float,
                          A: float, alpha_s: float, beta: float,
                          S: float, ap: float, lmb: float, nu: float, w: float, safe: bool = True) -> tuple[float, float]:
    """
    EM4 Derk-SE Model with Dimensionless Secondary Emission factor Psec.
    Psec is dimensionless ratio scaled by Ip/KG2 in current equations.
    """
    if safe:
        va_eff = 0.5 * (va + math.sqrt(va * va + 0.01))
        vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01))
    else:
        va_eff = va
        vs_eff = vs

    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0:
        return 0.0, 0.0

    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0:
        return 0.0, 0.0

    ip_koren = 1000.0 * (e1 ** ex)
    alpha = max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s))

    denom = 1.0 + beta * va_eff
    if abs(denom) < 1e-9:
        return 0.0, 0.0

    # Secondary emission crossover potential
    vco = (vs_eff / lmb) - nu * vg - w
    # Dimensionless factor Psec
    psec = S * va_eff * (1.0 - math.tanh(ap * (va_eff - vco)))

    # Is = (Ip / KG2) * (1 + alpha_s/denom + psec)
    is_pred = (ip_koren / kg2) * (1.0 + alpha_s / denom + psec)

    # Ia = Ip * (1/KG1 - 1/KG2 + A*va/KG1 - psec/KG2 - (alpha/KG1 + alpha_s/KG2)/denom)
    term1 = (1.0 / kg1) - (1.0 / kg2)
    term2 = (A * va_eff) / kg1
    term3 = psec / kg2
    term4 = (1.0 / denom) * (alpha / kg1 + alpha_s / kg2)
    ia_pred = ip_koren * (term1 + term2 - term3 - term4)

    if safe and va < 0:
        cutoff = math.exp((va - math.sqrt(va * va + 1e-4)) / 4.0)
        ia_pred *= cutoff
        is_pred *= cutoff

    return max(0.0, ia_pred), max(0.0, is_pred)


# ----------------------------------------------------------------------
# SPICE Subcircuit Code Generators (English Comments & Pure MIN/MAX Clamping)
# ----------------------------------------------------------------------
def generate_triode_koren_spice(name: str, p: dict) -> str:
    return f"""* ====================================================
* Triode Model (Norman Koren): {name}
* Exact MIN/MAX Clamp for ngspice 46 Compatibility
* ====================================================
.SUBCKT {name} 1 2 3 PARAMS: MU={p['mu']:.4f} EX={p['ex']:.4f} KG1={p['kg1']:.4f} KP={p['kp']:.4f} KVB={p['kvb']:.4f} CCG=0.0P CGP=0.0P CCP=0.0P RGI=2000 ; A G C
X1 1 2 3 TriodeK MU={{MU}} EX={{EX}} KG1={{KG1}} KP={{KP}} KVB={{KVB}} RGI={{RGI}} CCG={{CCG}} CGP={{CGP}} CCP={{CCP}} ;
.ENDS {name}

.SUBCKT TriodeK 1 2 3 PARAMS: MU=0 EX=0 KG1=0 KP=0 KVB=0 CCG=0 CGP=0 CCP=0 RGI=2000
E1 7 0 VALUE={{V(1,3)/KP*LOG(1+EXP(MIN(MAX(KP*(1/MU+V(2,3)/SQRT(KVB+V(1,3)*V(1,3))), -50), 50)))}}
RE1 7 0 1G
G1 1 3 VALUE={{0.5*(PWR(V(7),EX)+PWRS(V(7),EX))/KG1}}
RCP 1 3 1G
C1 2 3 {{CCG}}
C2 2 1 {{CGP}}
C3 1 3 {{CCP}}
R1 2 5 {{RGI}}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS TriodeK
"""


def generate_safe_derk_spice(name: str, p: dict) -> str:
    alpha = max(0.0, 1.0 - (p["kg1"] / p["kg2"]) * (1.0 + p["alpha_s"]))
    ookg1m2 = (alpha / p["kg1"]) + (p["alpha_s"] / p["kg2"])
    aokg1 = abs(p["A"]) / p["kg1"]
    diff_kg = (1.0 / p["kg1"]) - (1.0 / p["kg2"])

    return f"""* ====================================================
* Transient-Safe Derk Pentode Model: {name}
* Singularity-free & ngspice 46 Compatible (MIN/MAX Clamped)
* ====================================================
.SUBCKT {name} 1 2 3 4 PARAMS: RGI=2000 CCG1=0 CCG2=0 CG1G2=0 CPG1=0 CCP=0 ; A G2 G1 C

* 1. Smooth positive effective voltages (Eliminates negative plate singularity)
E_VA_EFF 10 0 VALUE={{ 0.5 * (V(1,4) + SQRT(V(1,4)*V(1,4) + 0.01)) }}
E_VS_EFF 20 0 VALUE={{ 0.5 * (V(2,4) + SQRT(V(2,4)*V(2,4) + 0.01)) }}

* 2. Koren Space Potential E1 (MIN/MAX numerical clamp)
E1 7 0 VALUE={{ V(20)/{p['kp']:.4f} * LOG(1 + EXP(MIN(MAX({p['kp']:.4f}*(1/{p['mu']:.4f} + V(3,4)/SQRT({p['kvb']:.4f} + V(20)*V(20))), -50), 50))) }}

* 3. Koren Space Current Ip (Inlined smooth-positive inside PWR to prevent Newton NaNs)
E_IP 80 0 VALUE={{ PWR(0.5 * (V(7) + SQRT(V(7)*V(7) + 1e-12)), {p['ex']:.4f}) }}

* 4. Smooth negative plate voltage cutoff factor (ngspice 46 compatible without IF)
E_CUTOFF 95 0 VALUE={{ EXP((V(1,4) - SQRT(V(1,4)*V(1,4) + 0.0001)) / 4.0) }}

* 5. Current Sources (Inlined Newton-safe denominator)
G2 2 4 VALUE={{ (V(80) / {p['kg2']:.4f}) * (1.0 + {abs(p['alpha_s']):.4f} / (1.0 + {abs(p['beta']):.9e} * V(10))) * V(95) }}
G1 1 4 VALUE={{ V(80) * ({diff_kg:.9e} + {aokg1:.9e} * V(10) - (1.0 / (1.0 + {abs(p['beta']):.9e} * V(10))) * {ookg1m2:.9e}) * V(95) }}

* 6. Grid Diode & Parasitic Capacitances
R1 3 5 {{RGI}}
D3 5 4 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
RCP 1 4 1G
RCS 2 4 1G
C1 3 4 {{CCG1}}
C2 2 4 {{CCG2}}
C3 3 2 {{CG1G2}}
C4 3 1 {{CPG1}}
C5 1 4 {{CCP}}
.ENDS {name}
"""


def generate_safe_derke_spice(name: str, p: dict) -> str:
    alpha = max(0.0, 1.0 - (p["kg1"] / p["kg2"]) * (1.0 + p["alpha_s"]))
    ookg1m2 = (alpha / p["kg1"]) + (p["alpha_s"] / p["kg2"])
    aokg1 = abs(p["A"]) / p["kg1"]
    diff_kg = (1.0 / p["kg1"]) - (1.0 / p["kg2"])

    return f"""* ====================================================
* Transient-Safe DerkE Pentode/Beam Tetrode Model: {name}
* Exponential Knee & Cold-start Newton-Safe
* ====================================================
.SUBCKT {name} 1 2 3 4 PARAMS: RGI=2000 CCG1=0 CCG2=0 CG1G2=0 CPG1=0 CCP=0 ; A G2 G1 C

* 1. Smooth positive effective voltages (Eliminates negative plate singularity)
E_VA_EFF 10 0 VALUE={{ 0.5 * (V(1,4) + SQRT(V(1,4)*V(1,4) + 0.01)) }}
E_VS_EFF 20 0 VALUE={{ 0.5 * (V(2,4) + SQRT(V(2,4)*V(2,4) + 0.01)) }}

* 2. Koren Space Potential E1 (MIN/MAX numerical clamp)
E1 7 0 VALUE={{ V(20)/{p['kp']:.4f} * LOG(1 + EXP(MIN(MAX({p['kp']:.4f}*(1/{p['mu']:.4f} + V(3,4)/SQRT({p['kvb']:.4f} + V(20)*V(20))), -50), 50))) }}

* 3. Koren Space Current Ip (Inlined smooth-positive inside PWR to prevent Newton NaNs)
E_IP 80 0 VALUE={{ PWR(0.5 * (V(7) + SQRT(V(7)*V(7) + 1e-12)), {p['ex']:.4f}) }}

* 4. Exponential Knee Term (Inlined smooth-positive directly on plate voltage V(1,4))
E_EXP 90 0 VALUE={{ EXP(-PWR(0.5 * ({abs(p['beta']):.9e} * V(1,4) + SQRT({abs(p['beta']):.9e} * {abs(p['beta']):.9e} * V(1,4)*V(1,4) + 1e-12)), 1.5)) }}

* 5. Smooth negative plate voltage cutoff factor
E_CUTOFF 95 0 VALUE={{ EXP((V(1,4) - SQRT(V(1,4)*V(1,4) + 0.0001)) / 4.0) }}

* 6. Current Sources
G2 2 4 VALUE={{ (V(80) / {p['kg2']:.4f}) * (1.0 + {abs(p['alpha_s']):.4f} * V(90)) * V(95) }}
G1 1 4 VALUE={{ V(80) * ({diff_kg:.9e} + {aokg1:.9e} * V(10) - V(90) * {ookg1m2:.9e}) * V(95) }}

* 7. Grid Diode & Parasitic Capacitances
R1 3 5 {{RGI}}
D3 5 4 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
RCP 1 4 1G
RCS 2 4 1G
C1 3 4 {{CCG1}}
C2 2 4 {{CCG2}}
C3 3 2 {{CG1G2}}
C4 3 1 {{CPG1}}
C5 1 4 {{CCP}}
.ENDS {name}
"""


def generate_safe_derk_se_spice(name: str, p: dict) -> str:
    """Generates Transient-Safe Derk-SE Pentode with Dimensionless Secondary Emission E2 branch."""
    # Nested SafeDerk Fallback: If S < 1e-10, auto-fallback to clean SafeDerk
    if p.get("S", 0.0) < 1e-10:
        return generate_safe_derk_spice(name, p)

    alpha = max(0.0, 1.0 - (p["kg1"] / p["kg2"]) * (1.0 + p["alpha_s"]))
    ookg1m2 = (alpha / p["kg1"]) + (p["alpha_s"] / p["kg2"])
    aokg1 = abs(p["A"]) / p["kg1"]
    diff_kg = (1.0 / p["kg1"]) - (1.0 / p["kg2"])

    return f"""* ====================================================
* Transient-Safe Derk-SE Pentode Model: {name}
* Secondary Emission (Dimensionless E2), Singularity-free & Cold-start Newton-Safe
* ====================================================
.SUBCKT {name} 1 2 3 4 PARAMS: RGI=2000 CCG1=0 CCG2=0 CG1G2=0 CPG1=0 CCP=0 ; A G2 G1 C

* 1. Smooth positive effective voltages (Eliminates negative plate singularity)
E_VA_EFF 10 0 VALUE={{ 0.5 * (V(1,4) + SQRT(V(1,4)*V(1,4) + 0.01)) }}
E_VS_EFF 20 0 VALUE={{ 0.5 * (V(2,4) + SQRT(V(2,4)*V(2,4) + 0.01)) }}

* 2. Koren Space Potential E1 (MIN/MAX numerical clamp)
E1 7 0 VALUE={{ V(20)/{p['kp']:.4f} * LOG(1 + EXP(MIN(MAX({p['kp']:.4f}*(1/{p['mu']:.4f} + V(3,4)/SQRT({p['kvb']:.4f} + V(20)*V(20))), -50), 50))) }}

* 3. Koren Space Current Ip (Inlined smooth-positive inside PWR to prevent Newton NaNs)
E_IP 80 0 VALUE={{ PWR(0.5 * (V(7) + SQRT(V(7)*V(7) + 1e-12)), {p['ex']:.4f}) }}

* 4. Secondary Emission Cross-over Voltage Vco (High precision NU formatting)
E_VCO 92 0 VALUE={{ V(20)/{p['lmb']:.4f} - {p['nu']:.9e}*V(3,4) - {p['w']:.4f} }}

* 5. Secondary Emission Dimensionless Factor Psec (E2 Branch with TANH MIN/MAX Clamp)
E_PSEC 94 0 VALUE={{ {abs(p['S']):.9e} * V(10) * (1.0 - TANH(MIN(MAX({abs(p['ap']):.9e} * (V(10) - V(92)), -20), 20))) }}

* 6. Smooth negative plate voltage cutoff factor
E_CUTOFF 95 0 VALUE={{ EXP((V(1,4) - SQRT(V(1,4)*V(1,4) + 0.0001)) / 4.0) }}

* 7. Current Sources (Correct EM4 E2 Dimensionless Formulation & Inlined Denominator)
G2 2 4 VALUE={{ (V(80) / {p['kg2']:.4f}) * (1.0 + {abs(p['alpha_s']):.4f} / (1.0 + {abs(p['beta']):.9e} * V(10)) + V(94)) * V(95) }}
G1 1 4 VALUE={{ V(80) * ({diff_kg:.9e} + {aokg1:.9e} * V(10) - V(94)/{p['kg2']:.4f} - (1.0 / (1.0 + {abs(p['beta']):.9e} * V(10))) * {ookg1m2:.9e}) * V(95) }}

* 8. Grid Diode & Parasitic Capacitances
R1 3 5 {{RGI}}
D3 5 4 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
RCP 1 4 1G
RCS 2 4 1G
C1 3 4 {{CCG1}}
C2 2 4 {{CCG2}}
C3 3 2 {{CG1G2}}
C4 3 1 {{CPG1}}
C5 1 4 {{CCP}}
.ENDS {name}
"""


# ----------------------------------------------------------------------
# Log-Space Multi-Start Optimization Engine
# ----------------------------------------------------------------------
def nelder_mead_log_space(cost_func, p0, step=0.1, max_iter=3000, no_improve_thr=1e-7):
    """
    Nelder-Mead optimization operating in Log-Space (y = ln(p)).
    Allows parameter steps to span multiple orders of magnitude (1e-15 to 1e6).
    """
    dim = len(p0)
    y0 = [math.log(max(1e-15, v)) for v in p0]
    
    def log_cost(y):
        p = [math.exp(v) for v in y]
        return cost_func(p)

    prev_best = log_cost(y0)
    no_improv = 0

    res = [[y0, prev_best]]
    for i in range(dim):
        y = list(y0)
        y[i] += step
        score = log_cost(y)
        res.append([y, score])

    alpha, gamma, rho, sigma = 1.0, 2.0, 0.5, 0.5

    for _ in range(max_iter):
        res.sort(key=lambda item: item[1])
        best = res[0][1]

        if best < prev_best - no_improve_thr:
            no_improv = 0
            prev_best = best
        else:
            no_improv += 1

        if no_improv >= 150:
            break

        y_centroid = [0.0] * dim
        for tup in res[:-1]:
            for i in range(dim):
                y_centroid[i] += tup[0][i] / dim

        yr = [y_centroid[i] + alpha * (y_centroid[i] - res[-1][0][i]) for i in range(dim)]
        rscore = log_cost(yr)

        if res[0][1] <= rscore < res[-2][1]:
            res[-1] = [yr, rscore]
            continue

        if rscore < res[0][1]:
            ye = [y_centroid[i] + gamma * (yr[i] - y_centroid[i]) for i in range(dim)]
            escore = log_cost(ye)
            res[-1] = [ye, escore] if escore < rscore else [yr, rscore]
            continue

        yc = [y_centroid[i] + rho * (res[-1][0][i] - y_centroid[i]) for i in range(dim)]
        cscore = log_cost(yc)
        if cscore < res[-1][1]:
            res[-1] = [yc, cscore]
            continue

        y1 = res[0][0]
        for i in range(1, len(res)):
            res[i][0] = [y1[j] + sigma * (res[i][0][j] - y1[j]) for j in range(dim)]
            res[i][1] = log_cost(res[i][0])

    res.sort(key=lambda item: item[1])
    best_p = [math.exp(v) for v in res[0][0]]
    return best_p, res[0][1]


def fit_koren_triode(data: list[tuple[float, float, float, float, float]]):
    def loss(p):
        mu, ex, kg1, kp, kvb = p
        if mu <= 5 or mu >= 200 or ex <= 0.5 or ex >= 3.0 or kg1 <= 10 or kg1 >= 2000 or kp <= 5 or kp >= 2000 or kvb <= 10 or kvb >= 10000:
            return 1e9
        err = sum((row[0] - koren_triode_ia(row[3], row[2], mu, ex, kg1, kp, kvb)) ** 2 for row in data)
        return err

    p0 = [53.3, 1.27, 168.0, 180.0, 2000.0]
    best_p, min_err = nelder_mead_log_space(loss, p0)
    mu_fit, ex_fit, kg1_fit, kp_fit, kvb_fit = best_p
    return {
        "model": "Koren Triode",
        "mu": mu_fit, "ex": ex_fit, "kg1": kg1_fit, "kp": kp_fit, "kvb": kvb_fit,
        "rmse": math.sqrt(min_err / len(data))
    }


def fit_derk_pentode(data: list[tuple[float, float, float, float, float]], model_mode: str = "derk", verbose: bool = True):
    is_derke = (model_mode == "derke")
    is_se = (model_mode == "derk-se")

    def loss(p):
        if is_se:
            mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w = p
            if ap <= 0 or lmb <= 0 or nu < 0:
                return 1e9
        else:
            mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta = p

        if mu <= 3 or ex <= 0.5 or kg1 <= 5 or kg2 <= 5 or kp <= 2 or kvb <= 5 or beta <= 0 or alpha_s < 0 or A < 0:
            return 1e9

        err = 0.0
        for ia_obs, is_obs, vg, va, vs in data:
            if is_se:
                ia_p, is_p = derk_se_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w, safe=True)
            elif is_derke:
                ia_p, is_p = derke_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, safe=True)
            else:
                ia_p, is_p = derk_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, safe=True)
            err += (ia_obs - ia_p) ** 2 + (is_obs - is_p) ** 2
        return err

    # Multi-start initial seeds across parameter orders of magnitude
    seeds = []
    if is_se:
        # Seed 1: Known PCL805 / EM4 reference values
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-5, 2.5, 0.0624, 1e-4, 0.01, 20.0, 1.0, 2.0])
        # Seed 2: Standard small signal pentode seed
        seeds.append([40.0, 1.3, 600.0, 4000.0, 300.0, 1800.0, 1e-5, 4.0, 0.01, 1e-5, 1e-3, 15.0, 2.0, 1.0])
        # Seed 3: Nested S=0 (No Secondary Emission baseline)
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-6, 2.5, 0.0624, 1e-15, 1e-6, 20.0, 1e-6, 0.1])
        # Seed 4: High perveance power tube seed
        seeds.append([15.0, 1.3, 200.0, 1000.0, 50.0, 100.0, 1e-4, 3.0, 0.03, 1e-4, 1e-2, 10.0, 1.5, 3.0])
    else:
        # Standard pentode seeds
        seeds.append([40.0, 1.3, 600.0, 4000.0, 300.0, 1800.0, 1e-5, 4.0, 0.01])
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-5, 2.5, 0.0624])
        seeds.append([20.0, 1.2, 300.0, 1500.0, 100.0, 500.0, 1e-4, 3.0, 0.03])

    best_global_p = None
    best_global_err = 1e18
    best_seed_idx = -1

    for idx, s in enumerate(seeds):
        p_opt, err = nelder_mead_log_space(loss, s, step=0.15, max_iter=2500)
        if err < best_global_err:
            best_global_err = err
            best_global_p = p_opt
            best_seed_idx = idx

    rmse = math.sqrt(best_global_err / (2 * len(data)))
    if verbose:
        print(f"[*] Multi-start log-space optimization completed ({len(seeds)} seeds evaluated). Best seed #{best_seed_idx+1}, RMSE = {rmse:.4f} mA")

    if is_se:
        mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w = best_global_p
        return {
            "model": "SafeDerk-SE Pentode (Secondary Emission)",
            "mu": mu, "ex": ex, "kg1": kg1, "kg2": kg2, "kp": kp, "kvb": kvb,
            "A": A, "alpha_s": alpha_s, "beta": beta,
            "S": S, "ap": ap, "lmb": lmb, "nu": nu, "w": w,
            "rmse": rmse
        }
    else:
        mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta = best_global_p
        model_name = "SafeDerkE Pentode/Beam Tetrode" if is_derke else "SafeDerk Pentode"
        return {
            "model": model_name,
            "mu": mu, "ex": ex, "kg1": kg1, "kg2": kg2, "kp": kp, "kvb": kvb,
            "A": A, "alpha_s": alpha_s, "beta": beta,
            "rmse": rmse
        }


def main():
    parser = argparse.ArgumentParser(
        description="ExtractModel-Safe: Vacuum Tube SPICE Parameter Fitting Engine & Transient-Safe Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  1. Fit single Triode UTD file:
     python3 fit_utd_model.py --model triode E92CC.utd

  2. Fit multiple Pentode UTD files & save transient-safe SPICE subcircuit:
     python3 fit_utd_model.py --model derk-se --name PCL805_Safe -o PCL805_Safe.cir PCL805-Vs125.utd PCL805-Vs170.utd PCL805-Vs210.utd
""",
    )
    parser.add_argument(
        "utd_files",
        nargs="+",
        help="Input .utd measurement data file(s). Multiple files allow multi-screen joint fitting.",
    )
    parser.add_argument(
        "-m", "--model",
        required=True,
        choices=["triode", "derk", "derke", "derk-se"],
        help="Target tube model type (REQUIRED: triode, derk, derke, derk-se)",
    )
    parser.add_argument(
        "-n", "--name",
        default="SafeTubeModel",
        help="Subcircuit name in generated SPICE code (default: SafeTubeModel)",
    )
    parser.add_argument(
        "-o", "--output",
        help="Optional output filepath to save generated SPICE subcircuit (.cir file)",
    )
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Suppress informational stdout logs",
    )

    args = parser.parse_args()

    start_t = time.time()
    data = []
    for fpath_str in args.utd_files:
        utd_path = Path(fpath_str)
        if not utd_path.exists():
            print(f"Error: File '{utd_path}' not found.", file=sys.stderr)
            sys.exit(1)
        utd_text = utd_path.read_text(encoding="utf-8", errors="ignore")
        pts = parse_utd_data(utd_text)
        data.extend(pts)
        if not args.quiet:
            print(f"[*] Parsed {len(pts)} points from {utd_path.name}.")

    if not data:
        print("Error: No valid measurement points parsed.", file=sys.stderr)
        sys.exit(1)

    if not args.quiet:
        print(f"[*] Combined dataset: {len(data)} total measurement points across {len(args.utd_files)} file(s).")

    model_mode = args.model.lower()

    if model_mode == "triode":
        res = fit_koren_triode(data)
        spice_code = generate_triode_koren_spice(args.name, res)
    else:
        res = fit_derk_pentode(data, model_mode=model_mode, verbose=not args.quiet)
        if model_mode == "derk-se":
            spice_code = generate_safe_derk_se_spice(args.name, res)
        elif model_mode == "derke":
            spice_code = generate_safe_derke_spice(args.name, res)
        else:
            spice_code = generate_safe_derk_spice(args.name, res)

    elapsed_t = time.time() - start_t

    if not args.quiet:
        print(f"\n====================================================")
        print(f"  Model Fit Results: {res['model']}")
        print(f"====================================================")
        for k, v in res.items():
            if k not in ("model", "rmse"):
                if isinstance(v, float) and (abs(v) < 1e-3 or abs(v) > 1e4):
                    print(f"  {k:<8} = {v:.9e}")
                elif isinstance(v, float):
                    print(f"  {k:<8} = {v:.4f}")
                else:
                    print(f"  {k:<8} = {v}")
        print(f"  RMSE     = {res['rmse']:.4f} mA")
        print(f"  Elapsed  = {elapsed_t:.2f} s")
        print(f"====================================================\n")

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(spice_code, encoding="utf-8")
        if not args.quiet:
            print(f"[+] Saved SPICE subcircuit to: {out_path.resolve()}")
    else:
        print("=== SPICE Subcircuit Output ===")
        print(spice_code)


if __name__ == "__main__":
    main()
