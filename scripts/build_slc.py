#!/usr/bin/env python3
"""Builds data/slc-streets.json from Utah UGRC road centerlines + SLC community council polygons.

Usage: python3 scripts/build_slc.py
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROADS = "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahRoads/FeatureServer/0/query"
COUNCILS = "https://services.arcgis.com/mMBpeYj0vPFotzbe/arcgis/rest/services/Salt_Lake_Community_Councils/FeatureServer/4/query"
# UGRC CARTOCODE: keep walkable public streets; drop interstates (1), separated highways (2, 4),
# ramps (7), 4WD/other (12), non-road (13), driveways (14), proposed (15), service access (17).
WALKABLE_CARTOCODES = ("3", "5", "6", "8", "9", "10", "11")
WHERE = (
    "(INCMUNI_L='Salt Lake City' OR INCMUNI_R='Salt Lake City') "
    f"AND CARTOCODE IN ({','.join(repr(c) for c in WALKABLE_CARTOCODES)}) "
    "AND FULLNAME IS NOT NULL AND FULLNAME <> ''"
)
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "slc-streets.json")


def get_json(url, params):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": "sf-streets-pwa/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all_roads():
    features, offset = [], 0
    while True:
        page = get_json(ROADS, {
            "where": WHERE,
            "outFields": "OBJECTID,UNIQUE_ID,FULLNAME",
            "outSR": "4326",
            "resultOffset": offset,
            "resultRecordCount": 2000,
            "f": "geojson",
        })
        batch = page.get("features", [])
        features.extend(batch)
        if len(batch) < 2000:
            return features
        offset += len(batch)


def fetch_councils():
    data = get_json(COUNCILS, {"where": "AREA_ID IS NOT NULL", "outFields": "AREA_ID,COMCOUNCIL_NAME", "outSR": "4326", "f": "geojson"})
    polys, seen = [], set()
    for f in data["features"]:
        area = f["properties"]["AREA_ID"]
        if area in seen:  # e.g. duplicate "KEEP Yalecrest" overlay
            continue
        seen.add(area)
        name = f["properties"]["COMCOUNCIL_NAME"].replace(" Community", "")
        geom = f["geometry"]
        rings = geom["coordinates"] if geom["type"] == "Polygon" else [r for poly in geom["coordinates"] for r in poly]
        polys.append((name, rings))
    return polys


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
    return inside


def neighborhood_for(pt, polys):
    for name, rings in polys:
        if any(point_in_ring(pt, ring) for ring in rings):
            return name
    return "Outlying SLC"


def pretty_name(raw):
    s = raw.strip().title()
    s = re.sub(r"\b(\d+)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), s)
    s = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), s)
    s = re.sub(r"\bO'([a-z])", lambda m: "O'" + m.group(1).upper(), s)
    s = re.sub(r"\b(Nb|Sb|Eb|Wb|Ne|Nw|Se|Sw)\b", lambda m: m.group(1).upper(), s)
    return s


def key(pt):
    return (round(pt[0], 4), round(pt[1], 4))


def main():
    print("fetching UGRC roads for Salt Lake City...", file=sys.stderr)
    roads = fetch_all_roads()
    print(f"  {len(roads)} segments", file=sys.stderr)
    polys = fetch_councils()
    print(f"  {len(polys)} community councils", file=sys.stderr)

    segments = []
    for f in roads:
        geom = f["geometry"]
        paths = [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]
        base_id = str(f["properties"].get("UNIQUE_ID") or f["properties"]["OBJECTID"])
        for i, path in enumerate(paths):
            coords = [[round(p[0], 5), round(p[1], 5)] for p in path]
            if len(coords) < 2:
                continue
            segments.append({
                "id": base_id if len(paths) == 1 else f"{base_id}-{i}",
                "s": pretty_name(f["properties"]["FULLNAME"]),
                "c": coords,
            })

    # Cross streets: the most common *other* street name touching each endpoint.
    touching = defaultdict(Counter)
    for seg in segments:
        for end in (seg["c"][0], seg["c"][-1]):
            touching[key(end)][seg["s"]] += 1

    def cross(seg, end):
        names = [n for n, _ in touching[key(end)].most_common() if n != seg["s"]]
        return names[0] if names else ""

    blocks = []
    for seg in segments:
        mid = seg["c"][len(seg["c"]) // 2]
        blocks.append({
            "id": seg["id"],
            "s": seg["s"],
            "f": cross(seg, seg["c"][0]),
            "t": cross(seg, seg["c"][-1]),
            "n": neighborhood_for(mid, polys),
            "c": seg["c"],
        })

    with open(OUT, "w") as fh:
        json.dump(blocks, fh, separators=(",", ":"))

    lons = [p[0] for b in blocks for p in b["c"]]
    lats = [p[1] for b in blocks for p in b["c"]]
    streets = {b["s"] for b in blocks}
    nhoods = Counter(b["n"] for b in blocks)
    print(f"wrote {len(blocks)} blocks, {len(streets)} streets, {len(nhoods)} neighborhoods -> {os.path.relpath(OUT)}", file=sys.stderr)
    print(f"bbox: [{min(lons):.3f}, {min(lats):.3f}, {max(lons):.3f}, {max(lats):.3f}]", file=sys.stderr)
    print("neighborhoods:", dict(nhoods.most_common()), file=sys.stderr)


if __name__ == "__main__":
    main()
