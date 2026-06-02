#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import shapefile

from render_worldmap import project, shape_parts, split_dateline


def point_line_distance(point, start, end):
    px, py = point
    sx, sy = start
    ex, ey = end
    dx = ex - sx
    dy = ey - sy

    if dx == 0 and dy == 0:
        return math.dist(point, start)

    t = ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.dist(point, (sx + t * dx, sy + t * dy))


def simplify_line(points, tolerance):
    if len(points) <= 2:
        return points

    start = points[0]
    end = points[-1]
    max_distance = 0
    split_index = 0

    for index, point in enumerate(points[1:-1], start=1):
        distance = point_line_distance(point, start, end)
        if distance > max_distance:
            max_distance = distance
            split_index = index

    if max_distance <= tolerance:
        return [start, end]

    left = simplify_line(points[: split_index + 1], tolerance)
    right = simplify_line(points[split_index:], tolerance)
    return left[:-1] + right


def simplify_ring(points, tolerance):
    if len(points) <= 4:
        return points

    closed = math.dist(points[0], points[-1]) < 0.001
    line = points[:-1] if closed else points
    simplified = simplify_line(line, tolerance)

    if closed:
        simplified.append(simplified[0])

    return simplified


def signed_area(points):
    area = 0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        area += x1 * y2 - x2 * y1
    return area / 2


def country_id(record, fields, index):
    values = dict(zip(fields, record))
    value = values["ADM0_A3"] or values["ISO_A3"] or values["NE_ID"]
    if value == "-99":
        value = values["NE_ID"]
    return str(value), values


def quantize(points, precision):
    return [[round(x, precision), round(y, precision)] for x, y in points]


def build_country_data(shapefile_path, width, height, projection, tolerance, precision):
    reader = shapefile.Reader(str(shapefile_path))
    fields = [field.name for field in reader.fields[1:]]
    used_ids = set()
    countries = []

    for index, shape_record in enumerate(reader.iterShapeRecords()):
        base_id, values = country_id(shape_record.record, fields, index)
        item_id = base_id
        suffix = 2
        while item_id in used_ids:
            item_id = f"{base_id}-{suffix}"
            suffix += 1
        used_ids.add(item_id)

        rings = []
        for part in shape_parts(shape_record.shape):
            for line in split_dateline(part):
                projected = [
                    project(lon, lat, width, height, 1, projection)
                    for lon, lat in line
                ]
                simplified = simplify_ring(projected, tolerance)
                if len(simplified) > 2 and abs(signed_area(simplified)) > 0.05:
                    rings.append(quantize(simplified, precision))

        if rings:
            countries.append({
                "id": item_id,
                "name": values["ADMIN"],
                "label": values["NAME_LONG"],
                "continent": values["CONTINENT"],
                "rings": rings,
            })

    countries.sort(key=lambda country: country["name"])

    return {
        "baseWidth": width,
        "baseHeight": height,
        "projection": projection,
        "countries": countries,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shapefile", default="data/ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp")
    parser.add_argument("--output", default="static/countries.json")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=600)
    parser.add_argument("--projection", choices=["equal-earth", "robinson"], default="equal-earth")
    parser.add_argument("--tolerance", type=float, default=0.28)
    parser.add_argument("--precision", type=int, default=1)
    args = parser.parse_args()

    data = build_country_data(
        Path(args.shapefile),
        args.width,
        args.height,
        args.projection,
        args.tolerance,
        args.precision,
    )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {output} with {len(data['countries'])} countries")


if __name__ == "__main__":
    main()
