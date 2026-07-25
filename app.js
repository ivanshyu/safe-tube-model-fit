/**
 * ExtractModel-Safe Web App Controller
 * Pure Frontend Pyodide (WebAssembly) Engine + Chart.js Realtime Renderer
 */

let pyodide = null;
let uploadedFiles = [];
let chartIa = null;
let chartIs = null;
let fitResults = null;

// DOM Elements
const pyodideStatusEl = document.getElementById('pyodide-status');
const dropzoneEl = document.getElementById('dropzone');
const fileInputEl = document.getElementById('file-input');
const fileListEl = document.getElementById('file-list');
const fitBtn = document.getElementById('fit-btn');
const fitBtnIconEl = document.getElementById('fit-btn-icon');
const fitBtnTextEl = document.getElementById('fit-btn-text');

const categoryPentodeRadio = document.getElementById('category-pentode');
const categoryTriodeRadio = document.getElementById('category-triode');
const radioPentodeLabel = document.getElementById('radio-pentode-label');
const radioTriodeLabel = document.getElementById('radio-triode-label');

const modelTypeEl = document.getElementById('model-type');
const subcktNameEl = document.getElementById('subckt-name');
const vsControlGroupEl = document.getElementById('vs-control-group');
const vsTargetEl = document.getElementById('vs-target');
const ulGroupEl = document.getElementById('ul-group');
const tapRatioEl = document.getElementById('tap-ratio');
const tapValueEl = document.getElementById('tap-value');

const metricPtsEl = document.getElementById('metric-pts');
const metricRmseEl = document.getElementById('metric-rmse');
const metricStatusEl = document.getElementById('metric-status');
const metricTimeEl = document.getElementById('metric-time');

const axisXminEl = document.getElementById('axis-xmin');
const axisXmaxEl = document.getElementById('axis-xmax');
const axisYminEl = document.getElementById('axis-ymin');
const axisYmaxEl = document.getElementById('axis-ymax');
const axisYunitEl = document.getElementById('axis-yunit');
const axisAutoBtn = document.getElementById('axis-auto-btn');

const chartLoadingOverlay = document.getElementById('chart-loading-overlay');
const codeLoadingOverlay = document.getElementById('code-loading-overlay');
const chartIsBoxEl = document.getElementById('chart-is-box');
const spiceCodeOutputEl = document.getElementById('spice-code-output');
const copyCodeBtn = document.getElementById('copy-code-btn');
const downloadCirBtn = document.getElementById('download-cir-btn');

/**
 * Robust Data-Space Label Placement Plugin for Chart.js
 * Computes exact exit point in Data Space (Va, Ia) and converts via Chart.js scale,
 * applying collision-prevention so bottom cutoff curves never overlap.
 */
const endLabelPlugin = {
  id: 'endLabelPlugin',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    const yScale = scales.y;
    if (!xScale || !yScale) return;

    ctx.save();
    ctx.font = '600 10px Inter, sans-serif';

    let lastDrawnRightPy = -999;

    chart.data.datasets.forEach((dataset) => {
      if (!dataset.vgLabel || !dataset.data || dataset.data.length < 2) return;

      const pts = dataset.data;
      const yMax = yScale.max;

      let topCrossIndex = -1;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].y >= yMax) {
          topCrossIndex = i;
          break;
        }
      }

      if (topCrossIndex > 0) {
        const pPrev = pts[topCrossIndex - 1];
        const pCurr = pts[topCrossIndex];
        const dy = pCurr.y - pPrev.y;
        const t = Math.abs(dy) > 1e-6 ? (yMax - pPrev.y) / dy : 0;
        const vaCross = pPrev.x + t * (pCurr.x - pPrev.x);

        const px = xScale.getPixelForValue(vaCross);
        const py = chartArea.top + 10;

        ctx.fillStyle = dataset.borderColor || '#ffb703';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(dataset.vgLabel, Math.min(px + 2, chartArea.right - 26), py);
      } else {
        const lastPt = pts[pts.length - 1];
        const px = xScale.getPixelForValue(lastPt.x);
        const py = yScale.getPixelForValue(lastPt.y);

        if (Math.abs(py - lastDrawnRightPy) >= 11 && py >= chartArea.top && py <= chartArea.bottom - 2) {
          ctx.fillStyle = dataset.borderColor || '#ffb703';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(dataset.vgLabel, Math.min(px - 26, chartArea.right - 26), py);
          lastDrawnRightPy = py;
        }
      }
    });

    ctx.restore();
  }
};

// Register plugin
Chart.register(endLabelPlugin);

// Embedded Python Engine Script with Non-Blocking Asyncio Event Loop Yielding
const pythonEngineCode = `
import math
import asyncio

def parse_utd_data(utd_text):
    rows = []
    for line in utd_text.strip().splitlines():
        parts = line.split()
        if len(parts) == 8 and parts[0].isdigit():
            ia = float(parts[2])
            is_ = float(parts[3])
            vg = float(parts[4])
            va = float(parts[5])
            vs = float(parts[6])
            rows.append((ia, is_, vg, va, vs))
    return rows

def koren_triode_ia(va, vg, mu, ex, kg1, kp, kvb):
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kp <= 0 or kvb <= 0: return 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + va * va))
    arg = max(-50.0, min(50.0, arg))
    e1 = (va / kp) * math.log(1.0 + math.exp(arg))
    return 1000.0 * (e1 ** ex) / kg1 if e1 > 0 else 0.0

def koren_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb):
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0: return 0.0, 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs * vs))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0: return 0.0, 0.0
    e1_ex = e1 ** ex
    ia = 1000.0 * (e1_ex / kg1) * math.atan(va / kvb)
    is_ = 1000.0 * (e1_ex / kg2)
    return max(0.0, ia), max(0.0, is_)

def derk_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, safe=True):
    va_eff = 0.5 * (va + math.sqrt(va * va + 0.01)) if safe else va
    vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01)) if safe else vs
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0: return 0.0, 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0: return 0.0, 0.0
    ip_koren = 1000.0 * (e1 ** ex)
    alpha = max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s))
    denom = 1.0 + beta * va_eff
    if abs(denom) < 1e-9: return 0.0, 0.0
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

def derke_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, safe=True):
    va_eff = 0.5 * (va + math.sqrt(va * va + 0.01)) if safe else va
    vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01)) if safe else vs
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0: return 0.0, 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0: return 0.0, 0.0
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

def derk_se_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w, safe=True):
    va_eff = 0.5 * (va + math.sqrt(va * va + 0.01)) if safe else va
    vs_eff = 0.5 * (vs + math.sqrt(vs * vs + 0.01)) if safe else vs
    if mu <= 0 or ex <= 0 or kg1 <= 0 or kg2 <= 0 or kp <= 0 or kvb <= 0 or beta <= 0: return 0.0, 0.0
    arg = kp * (1.0 / mu + vg / math.sqrt(kvb + vs_eff * vs_eff))
    arg = max(-50.0, min(50.0, arg))
    e1 = (vs_eff / kp) * math.log(1.0 + math.exp(arg))
    if e1 <= 0: return 0.0, 0.0
    ip_koren = 1000.0 * (e1 ** ex)
    alpha = max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s))
    denom = 1.0 + beta * va_eff
    if abs(denom) < 1e-9: return 0.0, 0.0
    vco = (vs_eff / lmb) - nu * vg - w
    psec = S * va_eff * (1.0 - math.tanh(ap * (va_eff - vco)))
    is_pred = (ip_koren / kg2) * (1.0 + alpha_s / denom + psec)
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

async def nelder_mead_log_space_async(cost_func, p0, step=0.1, max_iter=2500, no_improve_thr=1e-7):
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
        res.append([y, log_cost(y)])
    alpha, gamma, rho, sigma = 1.0, 2.0, 0.5, 0.5
    
    for iteration in range(max_iter):
        # Non-blocking yield to JS browser event loop every 30 iterations
        if iteration % 30 == 0:
            await asyncio.sleep(0.001)

        res.sort(key=lambda item: item[1])
        best = res[0][1]
        if best < prev_best - no_improve_thr:
            no_improv = 0
            prev_best = best
        else:
            no_improv += 1
        if no_improv >= 150: break
        y_centroid = [0.0] * dim
        for tup in res[:-1]:
            for i in range(dim): y_centroid[i] += tup[0][i] / dim
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
    return [math.exp(v) for v in res[0][0]], res[0][1]

async def run_fitting_async(data_points, model_mode, subckt_name):
    if model_mode == "triode":
        def loss(p):
            mu, ex, kg1, kp, kvb = p
            if mu <= 5 or mu >= 200 or ex <= 0.5 or ex >= 3.0 or kg1 <= 10 or kg1 >= 2000 or kp <= 5 or kp >= 2000 or kvb <= 10 or kvb >= 10000: return 1e9
            return sum((row[0] - koren_triode_ia(row[3], row[2], mu, ex, kg1, kp, kvb)) ** 2 for row in data_points)
        p0 = [53.3, 1.27, 168.0, 180.0, 2000.0]
        best_p, min_err = await nelder_mead_log_space_async(loss, p0)
        rmse = math.sqrt(min_err / len(data_points))
        p_dict = {"mu": best_p[0], "ex": best_p[1], "kg1": best_p[2], "kp": best_p[3], "kvb": best_p[4], "rmse": rmse}
        spice = f"""* Triode Model (Norman Koren): {subckt_name}
.SUBCKT {subckt_name} 1 2 3 PARAMS: MU={p_dict['mu']:.4f} EX={p_dict['ex']:.4f} KG1={p_dict['kg1']:.4f} KP={p_dict['kp']:.4f} KVB={p_dict['kvb']:.4f} CCG=0.0P CGP=0.0P CCP=0.0P RGI=2000 ; A G C
X1 1 2 3 TriodeK MU={{MU}} EX={{EX}} KG1={{KG1}} KP={{KP}} KVB={{KVB}} RGI={{RGI}} CCG={{CCG}} CGP={{CGP}} CCP={{CCP}}
.ENDS {subckt_name}

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
.ENDS TriodeK"""
        return p_dict, spice

    if model_mode == "koren-pentode":
        def loss(p):
            mu, ex, kg1, kg2, kp, kvb = p
            if mu <= 3 or ex <= 0.5 or kg1 <= 10 or kg2 <= 10 or kp <= 5 or kvb <= 5: return 1e9
            err = 0.0
            for ia_obs, is_obs, vg, va, vs in data_points:
                ia_p, is_p = koren_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb)
                err += (ia_obs - ia_p)**2 + (is_obs - is_p)**2
            return err
        p0 = [10.6, 1.25, 160.0, 500.0, 26.0, 15.0]
        best_p, min_err = await nelder_mead_log_space_async(loss, p0)
        rmse = math.sqrt(min_err / (2 * len(data_points)))
        p_dict = {"mu": best_p[0], "ex": best_p[1], "kg1": best_p[2], "kg2": best_p[3], "kp": best_p[4], "kvb": best_p[5], "rmse": rmse}
        spice = f"""* Pentode Model (Norman Koren Empirical): {subckt_name}
.SUBCKT {subckt_name} 1 2 3 4 PARAMS: MU={p_dict['mu']:.4f} EX={p_dict['ex']:.4f} KG1={p_dict['kg1']:.4f} KP={p_dict['kp']:.4f} KVB={p_dict['kvb']:.4f} KG2={p_dict['kg2']:.4f} CCG=0 CCS=0 CGS=0 CGP=0 CCP=0 RGI=2000 ; A G2 G1 C
E1 7 0 VALUE={{V(2,4)*LOG(1+EXP(MIN(MAX(KP*(1/MU+V(3,4)/SQRT(KVB+V(2,4)*V(2,4))), -50), 50)))/KP}}
RE1 7 0 1G
G1 1 4 VALUE={{0.5*PWR(0.5*(V(7)+SQRT(V(7)*V(7)+1e-12)),EX)*ATAN(V(1,4)/KVB)/KG1}}
G2 2 4 VALUE={{0.5*PWR(0.5*(V(7)+SQRT(V(7)*V(7)+1e-12)),EX)/KG2}}
R1 3 5 {{RGI}}
D3 5 4 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
RCP 1 4 1G
RCS 2 4 1G
C1 3 4 {{CCG}}
C2 2 4 {{CCS}}
C3 3 2 {{CGS}}
C4 3 1 {{CGP}}
C5 1 4 {{CCP}}
.ENDS {subckt_name}"""
        return p_dict, spice

    is_derke = (model_mode == "derke")
    is_se = (model_mode == "derk-se")

    def loss(p):
        if is_se:
            mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w = p
            if ap <= 0 or lmb <= 0 or nu < 0: return 1e9
        else:
            mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta = p
        if mu <= 3 or ex <= 0.5 or kg1 <= 5 or kg2 <= 5 or kp <= 2 or kvb <= 5 or beta <= 0 or alpha_s < 0 or A < 0: return 1e9
        err = 0.0
        for ia_obs, is_obs, vg, va, vs in data_points:
            if is_se: ia_p, is_p = derk_se_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta, S, ap, lmb, nu, w)
            elif is_derke: ia_p, is_p = derke_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta)
            else: ia_p, is_p = derk_pentode_ia_is(va, vs, vg, mu, ex, kg1, kg2, kp, kvb, A, alpha_s, beta)
            err += (ia_obs - ia_p)**2 + (is_obs - is_p)**2
        return err

    seeds = []
    if is_se:
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-5, 2.5, 0.0624, 1e-4, 0.01, 20.0, 1.0, 2.0])
        seeds.append([40.0, 1.3, 600.0, 4000.0, 300.0, 1800.0, 1e-5, 4.0, 0.01, 1e-5, 1e-3, 15.0, 2.0, 1.0])
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-6, 2.5, 0.0624, 1e-15, 1e-6, 20.0, 1e-6, 0.1])
    else:
        seeds.append([40.0, 1.3, 600.0, 4000.0, 300.0, 1800.0, 1e-5, 4.0, 0.01])
        seeds.append([10.6, 1.245, 163.0, 593.3, 26.1, 15.4, 1e-5, 2.5, 0.0624])

    best_p, best_err = None, 1e18
    for s in seeds:
        p_opt, err = await nelder_mead_log_space_async(loss, s, step=0.15, max_iter=2000)
        if err < best_err:
            best_err = err
            best_p = p_opt
    rmse = math.sqrt(best_err / (2 * len(data_points)))

    p_dict = {
        "mu": best_p[0], "ex": best_p[1], "kg1": best_p[2], "kg2": best_p[3],
        "kp": best_p[4], "kvb": best_p[5], "A": best_p[6], "alpha_s": best_p[7], "beta": best_p[8],
        "rmse": rmse
    }
    if is_se:
        p_dict.update({"S": best_p[9], "ap": best_p[10], "lmb": best_p[11], "nu": best_p[12], "w": best_p[13]})

    p = p_dict
    alpha = max(0.0, 1.0 - (p["kg1"] / p["kg2"]) * (1.0 + p["alpha_s"]))
    ookg1m2 = (alpha / p["kg1"]) + (p["alpha_s"] / p["kg2"])
    aokg1 = abs(p["A"]) / p["kg1"]
    diff_kg = (1.0 / p["kg1"]) - (1.0 / p["kg2"])

    if is_se and p.get("S", 0.0) >= 1e-10:
        spice = f"""* Transient-Safe Derk-SE Pentode Model: {subckt_name}
.SUBCKT {subckt_name} 1 2 3 4 PARAMS: RGI=2000 CCG1=0 CCG2=0 CG1G2=0 CPG1=0 CCP=0 ; A G2 G1 C
E_VA_EFF 10 0 VALUE={{ 0.5 * (V(1,4) + SQRT(V(1,4)*V(1,4) + 0.01)) }}
E_VS_EFF 20 0 VALUE={{ 0.5 * (V(2,4) + SQRT(V(2,4)*V(2,4) + 0.01)) }}
E1 7 0 VALUE={{ V(20)/{p['kp']:.4f} * LOG(1 + EXP(MIN(MAX({p['kp']:.4f}*(1/{p['mu']:.4f} + V(3,4)/SQRT({p['kvb']:.4f} + V(20)*V(20))), -50), 50))) }}
E_IP 80 0 VALUE={{ PWR(0.5 * (V(7) + SQRT(V(7)*V(7) + 1e-12)), {p['ex']:.4f}) }}
E_VCO 92 0 VALUE={{ V(20)/{p['lmb']:.4f} - {p['nu']:.9e}*V(3,4) - {p['w']:.4f} }}
E_PSEC 94 0 VALUE={{ {abs(p['S']):.9e} * V(10) * (1.0 - TANH(MIN(MAX({abs(p['ap']):.9e} * (V(10) - V(92)), -20), 20))) }}
E_CUTOFF 95 0 VALUE={{ EXP((V(1,4) - SQRT(V(1,4)*V(1,4) + 0.0001)) / 4.0) }}
G2 2 4 VALUE={{ (V(80) / {p['kg2']:.4f}) * (1.0 + {abs(p['alpha_s']):.4f} / (1.0 + {abs(p['beta']):.9e} * V(10)) + V(94)) * V(95) }}
G1 1 4 VALUE={{ V(80) * ({diff_kg:.9e} + {aokg1:.9e} * V(10) - V(94)/{p['kg2']:.4f} - (1.0 / (1.0 + {abs(p['beta']):.9e} * V(10))) * {ookg1m2:.9e}) * V(95) }}
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
.ENDS {subckt_name}"""
    else:
        spice = f"""* Transient-Safe Derk Pentode Model: {subckt_name}
.SUBCKT {subckt_name} 1 2 3 4 PARAMS: RGI=2000 CCG1=0 CCG2=0 CG1G2=0 CPG1=0 CCP=0 ; A G2 G1 C
E_VA_EFF 10 0 VALUE={{ 0.5 * (V(1,4) + SQRT(V(1,4)*V(1,4) + 0.01)) }}
E_VS_EFF 20 0 VALUE={{ 0.5 * (V(2,4) + SQRT(V(2,4)*V(2,4) + 0.01)) }}
E1 7 0 VALUE={{ V(20)/{p['kp']:.4f} * LOG(1 + EXP(MIN(MAX({p['kp']:.4f}*(1/{p['mu']:.4f} + V(3,4)/SQRT({p['kvb']:.4f} + V(20)*V(20))), -50), 50))) }}
E_IP 80 0 VALUE={{ PWR(0.5 * (V(7) + SQRT(V(7)*V(7) + 1e-12)), {p['ex']:.4f}) }}
E_CUTOFF 95 0 VALUE={{ EXP((V(1,4) - SQRT(V(1,4)*V(1,4) + 0.0001)) / 4.0) }}
G2 2 4 VALUE={{ (V(80) / {p['kg2']:.4f}) * (1.0 + {abs(p['alpha_s']):.4f} / (1.0 + {abs(p['beta']):.9e} * V(10))) * V(95) }}
G1 1 4 VALUE={{ V(80) * ({diff_kg:.9e} + {aokg1:.9e} * V(10) - (1.0 / (1.0 + {abs(p['beta']):.9e} * V(10))) * {ookg1m2:.9e}) * V(95) }}
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
.ENDS {subckt_name}"""

    return p_dict, spice
`;

// Initialize Pyodide
async function initPyodide() {
  try {
    pyodide = await loadPyodide();
    await pyodide.runPythonAsync(pythonEngineCode);
    pyodideStatusEl.className = 'status-indicator ready';
    pyodideStatusEl.querySelector('.status-text').textContent = 'Python WebAssembly Engine Ready';
  } catch (err) {
    console.error('Pyodide initialization failed:', err);
    pyodideStatusEl.className = 'status-indicator';
    pyodideStatusEl.querySelector('.status-text').textContent = 'WebAssembly Failed';
  }
}

// Category Switcher Handler
function updateCategoryUI() {
  const isPentode = categoryPentodeRadio.checked;

  if (isPentode) {
    radioPentodeLabel.classList.add('active');
    radioTriodeLabel.classList.remove('active');
    
    modelTypeEl.innerHTML = `
      <option value="derk-se" selected>SafeDerk-SE (Pentode + Secondary Emission)</option>
      <option value="derke">SafeDerkE (Exponential Knee)</option>
      <option value="derk">SafeDerk (Standard Pentode)</option>
      <option value="koren-pentode">Norman Koren Pentode (Historical Empirical)</option>
    `;

    vsControlGroupEl.style.display = 'inline-flex';
    ulGroupEl.style.display = 'flex';
    chartIsBoxEl.style.display = 'flex';
  } else {
    radioTriodeLabel.classList.add('active');
    radioPentodeLabel.classList.remove('active');

    modelTypeEl.innerHTML = `
      <option value="triode" selected>Norman Koren Triode Model</option>
    `;

    vsControlGroupEl.style.display = 'none';
    ulGroupEl.style.display = 'none';
    chartIsBoxEl.style.display = 'none';
  }

  if (fitResults && pyodide) {
    renderCharts();
  }
}

categoryPentodeRadio.addEventListener('change', updateCategoryUI);
categoryTriodeRadio.addEventListener('change', updateCategoryUI);

// Auto 8~15 Lines Generator Rule (Multiples of 2 or 5)
axisAutoBtn.addEventListener('click', () => {
  if (!fitResults) return;
  autoGenerateVgLines();
  refreshChartsIfReady();
});

function autoGenerateVgLines() {
  if (!fitResults) return;
  const p = fitResults.params;
  const maxVa = parseFloat(axisXmaxEl.value) || 300;
  const maxIa = parseFloat(axisYmaxEl.value) || 100;
  const targetVs = parseFloat(vsTargetEl.value) || 250;
  const modelMode = modelTypeEl.value;

  let cutoffVg = -10;
  for (let vg = 0; vg >= -300; vg -= 0.5) {
    let res = calculateSinglePoint(maxVa, vg, targetVs, modelMode, p);
    if (res.ia <= 0.005 * maxIa) {
      cutoffVg = vg;
      break;
    }
  }

  const totalSpan = Math.abs(cutoffVg);
  const allowedSteps = [1, 2, 4, 5, 10, 15, 20, 25, 50];
  let bestStep = 2;
  let minDiff = 999;

  for (let s of allowedSteps) {
    let count = Math.floor(totalSpan / s) + 1;
    if (count >= 8 && count <= 15) {
      bestStep = s;
      break;
    }
    let diff = Math.abs(count - 11);
    if (diff < minDiff) {
      minDiff = diff;
      bestStep = s;
    }
  }

  const vgList = [];
  for (let vg = 0; vg >= cutoffVg - bestStep; vg -= bestStep) {
    vgList.push(Math.round(vg * 10) / 10);
    if (vgList.length >= 15) break;
  }

  if (vgList.length < 8) {
    let smallerStep = (bestStep > 2) ? (bestStep / 2) : 1;
    vgList.length = 0;
    for (let vg = 0; vg >= cutoffVg - smallerStep; vg -= smallerStep) {
      vgList.push(Math.round(vg * 10) / 10);
      if (vgList.length >= 15) break;
    }
  }
}

// Helper for single point calculation
function calculateSinglePoint(v, vg, vsNominal, modelMode, paramsMap) {
  const isPentode = categoryPentodeRadio.checked;
  const tapRatio = isPentode ? parseFloat(tapRatioEl.value) : 0;
  let vsActual = vsNominal + tapRatio * (v - vsNominal);

  const mu = paramsMap.get('mu');
  const ex = paramsMap.get('ex');
  const kg1 = paramsMap.get('kg1');
  const kg2 = paramsMap.get('kg2') || 1.0;
  const kp = paramsMap.get('kp');
  const kvb = paramsMap.get('kvb');
  const A = paramsMap.get('A') || 0.0;
  const alpha_s = paramsMap.get('alpha_s') || 0.0;
  const beta = paramsMap.get('beta') || 0.01;
  const S = paramsMap.get('S') || 0.0;
  const ap = paramsMap.get('ap') || 0.0;
  const lmb = paramsMap.get('lmb') || 10.0;
  const nu = paramsMap.get('nu') || 0.0;
  const w = paramsMap.get('w') || 0.0;

  let ia_c = 0, is_c = 0;

  if (modelMode === 'triode') {
    let arg = kp * (1.0 / mu + vg / Math.sqrt(kvb + v * v));
    arg = Math.max(-50, Math.min(50, arg));
    let e1 = (v / kp) * Math.log(1.0 + Math.exp(arg));
    ia_c = e1 > 0 ? 1000.0 * Math.pow(e1, ex) / kg1 : 0;
  } else if (modelMode === 'koren-pentode') {
    let arg = kp * (1.0 / mu + vg / Math.sqrt(kvb + vsActual * vsActual));
    arg = Math.max(-50, Math.min(50, arg));
    let e1 = (vsActual / kp) * Math.log(1.0 + Math.exp(arg));
    if (e1 > 0) {
      let e1_ex = Math.pow(e1, ex);
      ia_c = 1000.0 * (e1_ex / kg1) * Math.atan(v / kvb);
      is_c = 1000.0 * (e1_ex / kg2);
    }
  } else {
    let va_eff = 0.5 * (v + Math.sqrt(v * v + 0.01));
    let vs_eff = 0.5 * (vsActual + Math.sqrt(vsActual * vsActual + 0.01));
    let arg = kp * (1.0 / mu + vg / Math.sqrt(kvb + vs_eff * vs_eff));
    arg = Math.max(-50, Math.min(50, arg));
    let e1 = (vs_eff / kp) * Math.log(1.0 + Math.exp(arg));

    if (e1 > 0) {
      let ip_koren = 1000.0 * Math.pow(e1, ex);
      let alpha = Math.max(0.0, 1.0 - (kg1 / kg2) * (1.0 + alpha_s));

      if (modelMode === 'derk-se') {
        let denom = 1.0 + beta * va_eff;
        let vco = (vs_eff / lmb) - nu * vg - w;
        let psec = S * va_eff * (1.0 - Math.tanh(ap * (va_eff - vco)));
        is_c = (ip_koren / kg2) * (1.0 + alpha_s / denom + psec);
        let term1 = (1.0 / kg1) - (1.0 / kg2);
        let term2 = (A * va_eff) / kg1;
        let term3 = psec / kg2;
        let term4 = (1.0 / denom) * (alpha / kg1 + alpha_s / kg2);
        ia_c = ip_koren * (term1 + term2 - term3 - term4);
      } else if (modelMode === 'derke') {
        let exp_term = Math.exp(-Math.pow(beta * va_eff, 1.5));
        is_c = (ip_koren / kg2) * (1.0 + alpha_s * exp_term);
        let term1 = (1.0 / kg1) - (1.0 / kg2);
        let term2 = (A * va_eff) / kg1;
        let term3 = exp_term * (alpha / kg1 + alpha_s / kg2);
        ia_c = ip_koren * (term1 + term2 - term3);
      } else {
        let denom = 1.0 + beta * va_eff;
        is_c = (ip_koren / kg2) * (1.0 + alpha_s / denom);
        let term1 = (1.0 / kg1) - (1.0 / kg2);
        let term2 = (A * va_eff) / kg1;
        let term3 = (1.0 / denom) * (alpha / kg1 + alpha_s / kg2);
        ia_c = ip_koren * (term1 + term2 - term3);
      }
    }
  }
  return { ia: Math.max(0, ia_c), is_: Math.max(0, is_c) };
}

// Axis Controls Handlers
axisXminEl.addEventListener('change', refreshChartsIfReady);
axisXmaxEl.addEventListener('change', refreshChartsIfReady);
axisYminEl.addEventListener('change', refreshChartsIfReady);
axisYmaxEl.addEventListener('change', refreshChartsIfReady);
axisYunitEl.addEventListener('change', refreshChartsIfReady);
vsTargetEl.addEventListener('change', refreshChartsIfReady);

function refreshChartsIfReady() {
  if (fitResults && pyodide) {
    renderCharts();
  }
}

// File Drag and Drop Handlers
dropzoneEl.addEventListener('click', () => fileInputEl.click());
dropzoneEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzoneEl.classList.add('dragover');
});
dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('dragover'));
dropzoneEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzoneEl.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});
fileInputEl.addEventListener('change', (e) => {
  if (e.target.files.length) {
    handleFiles(e.target.files);
  }
});

async function handleFiles(files) {
  uploadedFiles = [];
  fileListEl.innerHTML = '';

  for (let file of files) {
    const text = await file.text();
    uploadedFiles.push({ name: file.name, text: text });
    
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-name"><i class="fa-regular fa-file-code"></i> ${file.name}</span><i class="fa-solid fa-circle-check" style="color: var(--green-success);"></i>`;
    fileListEl.appendChild(item);
  }

  fitBtn.disabled = uploadedFiles.length === 0 || !pyodide;
  metricPtsEl.textContent = 'Parsing...';
}

// UI Controls
tapRatioEl.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (val === 0) tapValueEl.textContent = 'Pentode (0% Tap)';
  else if (val === 1) tapValueEl.textContent = 'Triode (100% Tap)';
  else tapValueEl.textContent = `UL Mode (${Math.round(val * 100)}% Tap)`;
  
  refreshChartsIfReady();
});

// Non-blocking Async Fit Action preventing Chrome "Page Unresponsive" freezing alerts
fitBtn.addEventListener('click', async () => {
  if (!pyodide || uploadedFiles.length === 0) return;

  fitBtn.disabled = true;
  fitBtnIconEl.className = 'fa-solid fa-spinner fa-spin';
  fitBtnTextEl.textContent = 'Fitting Model...';

  chartLoadingOverlay.classList.add('active');
  codeLoadingOverlay.classList.add('active');

  metricStatusEl.className = 'metric-val status-running';
  metricStatusEl.textContent = 'Running...';

  // Allow browser UI to update spinner animation before starting Python async solver
  await new Promise(resolve => setTimeout(resolve, 60));

  const startT = performance.now();

  try {
    let combinedText = uploadedFiles.map(f => f.text).join('\n');
    pyodide.globals.set('raw_utd_text', combinedText);
    pyodide.globals.set('target_model', modelTypeEl.value);
    pyodide.globals.set('target_subckt', subcktNameEl.value || 'SafeTubeModel');

    // Run async Nelder-Mead with event loop yielding every 30 iterations
    await pyodide.runPythonAsync(`
parsed_points = parse_utd_data(raw_utd_text)
params_dict, spice_output = await run_fitting_async(parsed_points, target_model, target_subckt)
    `);

    const elapsedSec = ((performance.now() - startT) / 1000).toFixed(2);
    const parsedPoints = pyodide.globals.get('parsed_points').toJs();
    const params = pyodide.globals.get('params_dict').toJs();
    const spiceCode = pyodide.globals.get('spice_output');

    fitResults = { parsedPoints, params, spiceCode };

    let maxMeasuredVa = Math.max(...parsedPoints.map(p => p[3]));
    let maxMeasuredIa = Math.max(...parsedPoints.map(p => p[0]));
    axisXmaxEl.value = Math.ceil(maxMeasuredVa / 50) * 50;
    axisYmaxEl.value = Math.ceil(maxMeasuredIa / 10) * 10;

    let vsNominal = parsedPoints[0][4];
    vsTargetEl.value = Math.round(vsNominal);

    metricPtsEl.textContent = parsedPoints.length;
    metricRmseEl.textContent = `${params.get('rmse').toFixed(4)} mA`;
    metricStatusEl.className = 'metric-val status-success';
    metricStatusEl.textContent = 'Converged';
    metricTimeEl.textContent = `${elapsedSec} s`;

    spiceCodeOutputEl.textContent = spiceCode;

    autoGenerateVgLines();
    renderCharts();

  } catch (err) {
    console.error('Fitting error:', err);
    metricStatusEl.className = 'metric-val';
    metricStatusEl.style.color = 'var(--red-alert)';
    metricStatusEl.textContent = 'Failed';
    spiceCodeOutputEl.textContent = `Error during fitting: ${err.message}`;
  } finally {
    chartLoadingOverlay.classList.remove('active');
    codeLoadingOverlay.classList.remove('active');

    fitBtn.disabled = false;
    fitBtnIconEl.className = 'fa-solid fa-wand-magic-sparkles';
    fitBtnTextEl.textContent = 'Run Multi-Start Fitting';
  }
});

// Chart.js Realtime Datasheet Renderer (Clean 100% Simulated Curves with Smart Edge Intersection Labels)
function renderCharts() {
  if (!fitResults) return;

  const dataPoints = fitResults.parsedPoints;
  const paramsMap = fitResults.params;
  const modelMode = modelTypeEl.value;
  const isPentode = categoryPentodeRadio.checked;
  const targetVs = parseFloat(vsTargetEl.value) || 250;

  const yUnit = axisYunitEl.value;
  const yScaleFactor = (yUnit === 'A') ? 0.001 : 1.0;

  const xMin = parseFloat(axisXminEl.value) || 0;
  const xMax = parseFloat(axisXmaxEl.value) || 300;
  const yMin = parseFloat(axisYminEl.value) || 0;
  const yMax = parseFloat(axisYmaxEl.value) || 100;

  const iaDatasets = [];
  const isDatasets = [];

  const mu = paramsMap.get('mu');
  let cutoffVg = -10;
  for (let vg = 0; vg >= -300; vg -= 0.5) {
    let res = calculateSinglePoint(xMax, vg, targetVs, modelMode, paramsMap);
    if (res.ia <= 0.005 * yMax) {
      cutoffVg = vg;
      break;
    }
  }

  const totalSpan = Math.abs(cutoffVg);
  const allowedSteps = [1, 2, 4, 5, 10, 15, 20, 25, 50];
  let bestStep = 2;
  let minDiff = 999;

  for (let s of allowedSteps) {
    let count = Math.floor(totalSpan / s) + 1;
    if (count >= 8 && count <= 15) {
      bestStep = s;
      break;
    }
    let diff = Math.abs(count - 11);
    if (diff < minDiff) {
      minDiff = diff;
      bestStep = s;
    }
  }

  const vgList = [];
  for (let vg = 0; vg >= cutoffVg - bestStep; vg -= bestStep) {
    vgList.push(Math.round(vg * 10) / 10);
    if (vgList.length >= 15) break;
  }

  vgList.forEach((vgVal, idx) => {
    const hue = (idx * 360 / Math.max(1, vgList.length)) % 360;
    const color = `hsl(${hue}, 85%, 60%)`;
    const fitIaData = [];
    const fitIsData = [];

    const numPoints = 100;
    const dx = (xMax - xMin) / numPoints;
    for (let i = 0; i <= numPoints; i++) {
      let v = xMin + i * dx;
      let res = calculateSinglePoint(v, vgVal, targetVs, modelMode, paramsMap);
      fitIaData.push({ x: v, y: Math.max(0, res.ia * yScaleFactor) });
      fitIsData.push({ x: v, y: Math.max(0, res.is_ * yScaleFactor) });
    }

    iaDatasets.push({
      label: `Vg1 = ${vgVal}V`,
      vgLabel: `${vgVal}V`,
      data: fitIaData,
      borderColor: color,
      borderWidth: 2,
      pointRadius: 0,
      showLine: true
    });

    if (isPentode) {
      isDatasets.push({
        label: `Vg1 = ${vgVal}V`,
        vgLabel: `${vgVal}V`,
        data: fitIsData,
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        showLine: true
      });
    }
  });

  if (chartIa) chartIa.destroy();
  if (chartIs) chartIs.destroy();

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false }
    },
    scales: {
      x: {
        type: 'linear',
        min: xMin,
        max: xMax,
        title: { display: true, text: 'Anode Voltage Va (V)', color: '#8493a8' },
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#8493a8' }
      },
      y: {
        min: yMin,
        max: yMax,
        title: { display: true, text: `Current (${yUnit})`, color: '#8493a8' },
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#8493a8' }
      }
    }
  };

  chartIa = new Chart(document.getElementById('chart-ia'), {
    type: 'scatter',
    data: { datasets: iaDatasets },
    options: chartOptions
  });

  if (isPentode) {
    chartIs = new Chart(document.getElementById('chart-is'), {
      type: 'scatter',
      data: { datasets: isDatasets },
      options: chartOptions
    });
  }
}

// Copy & Download Actions
copyCodeBtn.addEventListener('click', () => {
  const code = spiceCodeOutputEl.textContent;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    copyCodeBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    setTimeout(() => copyCodeBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy SPICE', 2000);
  });
});

downloadCirBtn.addEventListener('click', () => {
  const code = spiceCodeOutputEl.textContent;
  if (!code) return;
  const name = subcktNameEl.value || 'SafeTubeModel';
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.cir`;
  a.click();
  URL.revokeObjectURL(url);
});

// Boot Pyodide
updateCategoryUI();
initPyodide();
