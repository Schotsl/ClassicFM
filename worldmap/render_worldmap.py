#!/usr/bin/env python3
import argparse
import colorsys
import math
from pathlib import Path

from PIL import Image, ImageDraw
import shapefile


A1 = 1.340264
A2 = -0.081106
A3 = 0.000893
A4 = 0.003796


ROBINSON_TABLE = [
    (1.0000, 0.0000),
    (0.9986, 0.0620),
    (0.9954, 0.1240),
    (0.9900, 0.1860),
    (0.9822, 0.2480),
    (0.9730, 0.3100),
    (0.9600, 0.3720),
    (0.9427, 0.4340),
    (0.9216, 0.4958),
    (0.8962, 0.5571),
    (0.8679, 0.6176),
    (0.8350, 0.6769),
    (0.7986, 0.7346),
    (0.7597, 0.7903),
    (0.7186, 0.8435),
    (0.6732, 0.8936),
    (0.6213, 0.9394),
    (0.5722, 0.9761),
    (0.5322, 1.0000),
]


def robinson(lon, lat):
    lat = max(-90.0, min(90.0, lat))
    sign = -1 if lat < 0 else 1
    abs_lat = abs(lat)
    index = min(int(abs_lat // 5), len(ROBINSON_TABLE) - 2)
    ratio = (abs_lat - index * 5) / 5
    x0, y0 = ROBINSON_TABLE[index]
    x1, y1 = ROBINSON_TABLE[index + 1]
    x_coef = x0 + (x1 - x0) * ratio
    y_coef = y0 + (y1 - y0) * ratio

    return (
        0.8487 * math.radians(lon) * x_coef,
        sign * 1.3523 * y_coef,
    )


def equal_earth(lon, lat):
    lon_rad = math.radians(lon)
    lat_rad = math.radians(max(-90.0, min(90.0, lat)))
    theta = math.asin(math.sqrt(3) * math.sin(lat_rad) / 2)
    theta2 = theta * theta
    theta6 = theta2 * theta2 * theta2
    theta8 = theta6 * theta2

    return (
        2 * math.sqrt(3) * lon_rad * math.cos(theta) / (3 * (A1 + 3 * A2 * theta2 + 7 * A3 * theta6 + 9 * A4 * theta8)),
        A1 * theta + A2 * theta * theta2 + A3 * theta * theta6 + A4 * theta * theta8,
    )


def projection_bounds(projection):
    if projection == "robinson":
        return (-0.8487 * math.pi, 0.8487 * math.pi)

    if projection == "equal-earth":
        left, _ = equal_earth(-180, 0)
        right, _ = equal_earth(180, 0)
        return (left, right)

    raise ValueError(f"Unknown projection: {projection}")


def project(lon, lat, width, height, render_scale, projection):
    min_x, max_x = projection_bounds(projection)
    scale = width * render_scale / (max_x - min_x)
    if projection == "robinson":
        x, y = robinson(lon, lat)
    else:
        x, y = equal_earth(lon, lat)

    return (
        (x - min_x) * scale,
        height * render_scale / 2 - y * scale,
    )


def country_color(index, alpha=220):
    hue = (index * 0.61803398875) % 1.0
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.86, 1.0)
    return (round(red * 255), round(green * 255), round(blue * 255), alpha)


def split_dateline(points):
    if len(points) < 2:
        return []

    lines = []
    current = [points[0]]
    for point in points[1:]:
        previous = current[-1]
        if abs(point[0] - previous[0]) > 180:
            if len(current) > 1:
                lines.append(current)
            current = [point]
        else:
            current.append(point)

    if len(current) > 1:
        lines.append(current)

    return lines


def shape_parts(shape):
    ends = list(shape.parts[1:]) + [len(shape.points)]
    for start, end in zip(shape.parts, ends):
        yield shape.points[start:end]


def draw_graticule(draw, width, height, render_scale, line_width, projection):
    color = (230, 230, 230, 80)
    for lon in range(-150, 181, 30):
        points = [
            project(lon, lat, width, height, render_scale, projection)
            for lat in range(-85, 86, 2)
        ]
        draw.line(points, fill=color, width=line_width)

    for lat in range(-60, 61, 30):
        points = [
            project(lon, lat, width, height, render_scale, projection)
            for lon in range(-180, 181, 2)
        ]
        draw.line(points, fill=color, width=line_width)


def render_countries(shapefile_path, width, height, render_scale, line_width, fill_alpha, graticule, projection):
    canvas = Image.new("RGBA", (width * render_scale, height * render_scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    scaled_line_width = max(1, round(line_width * render_scale))

    if graticule:
        draw_graticule(draw, width, height, render_scale, max(1, round(0.55 * render_scale)), projection)

    reader = shapefile.Reader(str(shapefile_path))
    countries = sorted(
        enumerate(reader.shapes()),
        key=lambda item: (item[1].bbox[2] - item[1].bbox[0]) * (item[1].bbox[3] - item[1].bbox[1]),
        reverse=True,
    )

    for color_index, (_, shape) in enumerate(countries):
        outline_color = country_color(color_index)
        fill_color = country_color(color_index, fill_alpha)
        for part in shape_parts(shape):
            for line in split_dateline(part):
                points = [
                    project(lon, lat, width, height, render_scale, projection)
                    for lon, lat in line
                ]
                if fill_alpha > 0 and len(points) > 2:
                    draw.polygon(points, fill=fill_color)
                if len(points) > 1:
                    draw.line(points, fill=outline_color, width=scaled_line_width, joint="curve")

    return canvas.resize((width, height), Image.Resampling.LANCZOS)


def fit_to_target(render, target_size):
    target_width, target_height = target_size
    scale = target_width / render.width
    scaled_height = round(render.height * scale)
    scaled = render.resize((target_width, scaled_height), Image.Resampling.LANCZOS)

    if scaled_height >= target_height:
        top = (scaled_height - target_height) // 2
        return scaled.crop((0, top, target_width, top + target_height)), top, scale

    fitted = Image.new("RGBA", target_size, (0, 0, 0, 0))
    top = (target_height - scaled_height) // 2
    fitted.alpha_composite(scaled, (0, top))
    return fitted, -top, scale


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="target.png")
    parser.add_argument("--shapefile", default="data/ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=600)
    parser.add_argument("--render-scale", type=int, default=3)
    parser.add_argument("--line-width", type=float, default=1.15)
    parser.add_argument("--fill-alpha", type=int, default=34)
    parser.add_argument("--projection", choices=["equal-earth", "robinson"], default="equal-earth")
    parser.add_argument("--no-graticule", action="store_true")
    parser.add_argument("--out-dir", default=".")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    shapefile_path = Path(args.shapefile)
    target_path = Path(args.target)

    if not shapefile_path.exists():
        raise FileNotFoundError(f"Missing shapefile: {shapefile_path}")
    if not target_path.exists():
        raise FileNotFoundError(f"Missing target image: {target_path}")

    render = render_countries(
        shapefile_path,
        args.width,
        args.height,
        args.render_scale,
        args.line_width,
        args.fill_alpha,
        not args.no_graticule,
        args.projection,
    )

    transparent_path = out_dir / "country_outlines_1024x600.png"
    preview_path = out_dir / "worldmap_1024x600.png"
    scaled_path = out_dir / "country_outlines_scaled_to_target.png"
    overlay_path = out_dir / "target_overlay.png"

    render.save(transparent_path)

    preview = Image.new("RGBA", render.size, (0, 0, 0, 255))
    preview.alpha_composite(render)
    preview.save(preview_path)

    target = Image.open(target_path).convert("RGBA")
    fitted, vertical_crop, scale = fit_to_target(render, target.size)
    fitted.save(scaled_path)

    overlay = target.copy()
    overlay.alpha_composite(fitted)
    overlay.save(overlay_path)

    print(f"wrote {transparent_path}")
    print(f"wrote {preview_path}")
    print(f"wrote {scaled_path}")
    print(f"wrote {overlay_path}")
    print(f"projection={args.projection} render={args.width}x{args.height} target={target.width}x{target.height} scale={scale:.3f} vertical_crop={vertical_crop}px")


if __name__ == "__main__":
    main()
