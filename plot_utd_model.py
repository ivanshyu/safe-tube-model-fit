#!/usr/bin/env python3
"""
plot_utd_model.py - Curve Visualization & Ultra-Linear Mode Simulator Utility

Plots measured uTracer .utd data points against fitted vacuum tube model curves
(Koren Triode, Derk, DerkE, Derk-SE) with support for Ultra-Linear (UL) tap ratios.
"""

import argparse
import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

from fit_utd_model import (
    parse_utd_data,
    fit_koren_triode,
    fit_derk_pentode,
    koren_triode_ia,
    derk_pentode_ia_is,
    derke_pentode_ia_is,
    derk_se_pentode_ia_is,
)


def plot_curves(data: list, res: dict, model_mode: str, tap_ratio: float = None, output_path: str = None, show: bool = True):
    if not HAS_MATPLOTLIB:
        print("Error: matplotlib is required for plotting. Install via 'pip install matplotlib'.", file=sys.stderr)
        sys.exit(1)

    # Group data by Vg1 and Vs
    groups = {}
    for ia, is_, vg, va, vs in data:
        key = (round(vg, 2), round(vs, 1))
        if key not in groups:
            groups[key] = []
        groups[key].append((va, ia, is_))

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
    
    title_mode = res['model']
    if tap_ratio is not None:
        if tap_ratio == 0.0:
            title_mode += " [Pentode Mode: 0% Tap]"
        elif tap_ratio == 1.0:
            title_mode += " [Triode-Connected Mode: 100% Tap (Vs=Va)]"
        else:
            title_mode += f" [Ultra-Linear Mode: {tap_ratio*100:.0f}% Tap]"

    fig.suptitle(f"ExtractModel-Safe Fit: {title_mode} (RMSE = {res['rmse']:.4f} mA)", fontsize=13, fontweight="bold")

    num_groups = len(groups)
    colors = plt.cm.plasma([i / max(1, num_groups - 1) for i in range(num_groups)])

    legend_handles = []
    legend_labels = []

    for idx, ((vg, vs_fixed), pts) in enumerate(sorted(groups.items())):
        pts.sort(key=lambda x: x[0])
        va_measured = [p[0] for p in pts]
        ia_measured = [p[1] for p in pts]
        is_measured = [p[2] for p in pts]

        c = colors[idx]
        lbl = f"Vg1={vg:.1f}V (Vs={vs_fixed:.0f}V)"

        # Measured points
        sc = ax1.scatter(va_measured, ia_measured, color=c, alpha=0.75, s=14)
        ax2.scatter(va_measured, is_measured, color=c, alpha=0.75, s=14)

        # Model fitted continuous curve
        va_dense = [v * 1.0 for v in range(int(max(va_measured) + 10))]
        ia_fit = []
        is_fit = []

        for v in va_dense:
            # Calculate effective screen voltage Vs based on Ultra-Linear tap ratio
            if tap_ratio is not None:
                # Vs_eff = Vs_nominal + tap_ratio * (Va - Vs_nominal)
                vs_actual = vs_fixed + tap_ratio * (v - vs_fixed)
            else:
                vs_actual = vs_fixed

            if model_mode == "triode":
                ia_c = koren_triode_ia(v, vg, res["mu"], res["ex"], res["kg1"], res["kp"], res["kvb"])
                is_c = 0.0
            elif model_mode == "derk-se":
                ia_c, is_c = derk_se_pentode_ia_is(
                    v, vs_actual, vg, res["mu"], res["ex"], res["kg1"], res["kg2"], res["kp"], res["kvb"],
                    res["A"], res["alpha_s"], res["beta"], res["S"], res["ap"], res["lmb"], res["nu"], res["w"]
                )
            elif model_mode == "derke":
                ia_c, is_c = derke_pentode_ia_is(
                    v, vs_actual, vg, res["mu"], res["ex"], res["kg1"], res["kg2"], res["kp"], res["kvb"],
                    res["A"], res["alpha_s"], res["beta"]
                )
            else:
                ia_c, is_c = derk_pentode_ia_is(
                    v, vs_actual, vg, res["mu"], res["ex"], res["kg1"], res["kg2"], res["kp"], res["kvb"],
                    res["A"], res["alpha_s"], res["beta"]
                )
            ia_fit.append(ia_c)
            is_fit.append(is_c)

        ln, = ax1.plot(va_dense, ia_fit, color=c, linewidth=1.5, linestyle="-")
        ax2.plot(va_dense, is_fit, color=c, linewidth=1.5, linestyle="-")

        legend_handles.append((sc, ln))
        legend_labels.append(lbl)

    ax1.set_title("Anode Current Ia vs Anode Voltage Va")
    ax1.set_xlabel("Anode Voltage Va (V)")
    ax1.set_ylabel("Anode Current Ia (mA)")
    ax1.grid(True, linestyle="--", alpha=0.4)

    ax2.set_title("Screen Current Ig2 vs Anode Voltage Va")
    ax2.set_xlabel("Anode Voltage Va (V)")
    ax2.set_ylabel("Screen Current Ig2 (mA)")
    ax2.grid(True, linestyle="--", alpha=0.4)

    ncols = 2 if len(legend_labels) > 16 else 1
    fig.legend(
        [h[0] for h in legend_handles],
        legend_labels,
        loc="center left",
        bbox_to_anchor=(0.88, 0.5),
        fontsize=7,
        title="Measurement Curves",
        title_fontsize=8,
        ncol=ncols,
        frameon=True,
    )

    plt.subplots_adjust(left=0.07, right=0.86, top=0.90, bottom=0.10, wspace=0.22)

    if output_path:
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        plt.savefig(out_p, dpi=300, bbox_inches="tight")
        print(f"[+] Saved curve plot image to: {out_p.resolve()}")

    if show:
        plt.show()


def main():
    parser = argparse.ArgumentParser(
        description="ExtractModel-Safe Curve Visualization & Ultra-Linear Simulator Utility",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("utd_files", nargs="+", help="Input .utd file(s) to plot")
    parser.add_argument(
        "-m", "--model",
        required=True,
        choices=["triode", "derk", "derke", "derk-se"],
        help="Model type (triode, derk, derke, derk-se)",
    )
    parser.add_argument(
        "-t", "--tap-ratio",
        type=float,
        help="Ultra-Linear transformer tap ratio (0.0 = Pentode, 0.43 = 43% UL, 1.0 = Triode-connected)",
    )
    parser.add_argument("-o", "--output", help="Optional output image path (e.g. plot.png)")
    parser.add_argument("--no-show", action="store_true", help="Do not open GUI window (useful for headless servers)")

    args = parser.parse_args()

    data = []
    for f in args.utd_files:
        p = Path(f)
        if p.exists():
            data.extend(parse_utd_data(p.read_text(encoding="utf-8", errors="ignore")))

    if not data:
        print("Error: No data points loaded.", file=sys.stderr)
        sys.exit(1)

    model_mode = args.model.lower()
    print(f"[*] Fitting {len(data)} measurement points for plotting...")

    if model_mode == "triode":
        res = fit_koren_triode(data)
    else:
        res = fit_derk_pentode(data, model_mode=model_mode, verbose=False)

    print(f"[*] Fit completed. RMSE = {res['rmse']:.4f} mA. Rendering plot...")
    plot_curves(data, res, model_mode, tap_ratio=args.tap_ratio, output_path=args.output, show=not args.no_show)


if __name__ == "__main__":
    main()
