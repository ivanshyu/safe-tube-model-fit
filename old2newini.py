#!/usr/bin/env python3
"""
old2newini.py - Convert ExtractModel 3.x fixed-line Model.ini to 4.x key-value NewModel.ini
"""
import sys
from pathlib import Path

def convert_ini(src_path: Path, dst_path: Path):
    lines = src_path.read_text().splitlines()
    out = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        parts = [p.strip() for p in line.split(",") if p.strip()]
        if len(parts) >= 2:
            out.append(f"{parts[0]} = {parts[1]}")
    dst_path.write_text("\n".join(out) + "\n")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 old2newini.py <Model.ini> <NewModel.ini>")
        sys.exit(1)
    convert_ini(Path(sys.argv[1]), Path(sys.argv[2]))
