"""Typeset a square product poster using a selected local artwork and typography palette."""

from decimal import Decimal
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import re
import json

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = {entry["id"]: entry for entry in json.loads((ROOT / "templates.json").read_text(encoding="utf-8"))}
FONTS = {
    "title": ("georgia.ttf", "DejaVuSerif.ttf"),
    "body": ("arial.ttf", "DejaVuSans.ttf"),
    "bold": ("arialbd.ttf", "DejaVuSans-Bold.ttf"),
}
CJK_FONTS = {
    "regular": ("msyh.ttc", "NotoSansCJK-Regular.ttc", "NotoSansSC-VF.ttf"),
    "bold": ("msyhbd.ttc", "NotoSansCJK-Bold.ttc", "NotoSansSC-VF.ttf"),
}
FONT_DIRS = (
    Path("C:/Windows/Fonts"),
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/opentype/noto"),
    Path("/System/Library/Fonts/Supplemental"),
)


@lru_cache(maxsize=96)
def font_for(role, size, cjk):
    choices = CJK_FONTS["regular" if role == "body" else "bold"] if cjk else FONTS[role]
    for name in choices:
        for directory in FONT_DIRS:
            candidate = directory / name
            if candidate.is_file():
                return ImageFont.truetype(str(candidate), size)
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    raise RuntimeError("Install DejaVu and Noto Sans CJK fonts to render posters.")


def font(text, role, size):
    # Use a CJK font for the whole mixed-language field to keep baselines aligned.
    cjk = bool(re.search(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]", text))
    return font_for(role, size, cjk)


def wrap(text, face, width):
    # Break Latin words at spaces and allow natural inter-character CJK breaks.
    tokens = re.findall(r"[a-zA-Z0-9]+(?:['’-][a-zA-Z0-9]+)*|\s+|.", text)
    lines = []
    current = ""
    for token in tokens:
        if token.isspace():
            if current:
                current = current.rstrip() + " "
            continue
        if face.getlength(current + token) <= width:
            current += token
            continue
        if current.strip():
            lines.append(current.rstrip())
        current = ""
        for character in token:
            if current and face.getlength(current + character) > width:
                lines.append(current)
                current = ""
            current += character
    if current.strip():
        lines.append(current.rstrip())
    return lines


def draw_card(canvas, layout):
    draw = ImageDraw.Draw(canvas)
    if layout == "postcard":
        draw.rounded_rectangle((87, 326, 707, 654), radius=29, fill="#edb8a8")
        draw.rounded_rectangle((83, 319, 711, 649), radius=29, fill="#fffaf3")
        draw.rounded_rectangle((94, 330, 700, 638), radius=23, outline="#da9a87", width=2)
    elif layout == "ticket":
        # Cut both notches through the ticket layer to reveal the actual water.
        layer = Image.new("RGBA", canvas.size)
        ticket = ImageDraw.Draw(layer)
        ticket.rounded_rectangle((65, 338, 728, 650), radius=16, fill="#fffbed")
        ticket.rounded_rectangle((568, 338, 728, 650), radius=16, fill="#ffdf80")
        ticket.rectangle((568, 338, 586, 650), fill="#ffdf80")
        for y in range(356, 636, 16):
            ticket.line((568, y, 568, y + 7), fill="#9e913f", width=2)
        for y in (338, 650):
            ticket.ellipse((556, y-12, 580, y+12), fill=(0,0,0,0))
        canvas.paste(layer, (0,0), layer)
    elif layout == "leaf":
        draw.rounded_rectangle((62, 329, 637, 663), radius=28, fill="#8ebda9")
        draw.rounded_rectangle((55, 322, 630, 656), radius=28, fill="#f8fcf0")
        draw.rounded_rectangle((70, 353, 76, 620), radius=3, fill="#7eac86")
    elif layout == "sunset":
        draw.rounded_rectangle((78, 329, 716, 664), radius=56, fill="#ba8c9b")
        draw.rounded_rectangle((76, 321, 714, 656), radius=56, fill="#fff7ee")
        draw.arc((324, 331, 470, 359), 205, 335, fill="#eeb091", width=3)


def render_poster(data: dict) -> bytes:
    """Return PNG bytes. The caller validates field lengths and the USD price."""
    style = TEMPLATES[data.get("template_id", "ocean-breeze")]
    artwork = ROOT / "backend" / "assets" / (style["id"] + ".webp")
    with Image.open(artwork) as source:
        canvas = source.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    layout = style.get("cardLayout")
    if layout:
        draw_card(canvas, layout)
    left, top, right, bottom = style["panel"]
    width = right - left
    price_text = f"${Decimal(str(data['price'])):,.2f}"
    price = font(price_text, "bold", 25)
    price_width = int(price.getlength(price_text)) + 28
    brand_text = data["brand"]
    product = data["product"]
    description = data["description"]
    centered = layout in ("postcard", "sunset")
    footer_price = layout == "sunset"
    side_price = layout == "ticket"
    inline_price = not (centered or side_price)
    brand_width = width - price_width - 28 if inline_price or layout == "postcard" else width
    # Fit all three fields as a group, so even a long unbroken word stays visible.
    for size in range(51, 12, -2):
        brand = font(brand_text, "bold", max(14, round(size * .39)))
        title = font(product, style["titleFont"], size)
        body = font(description, "body", max(13, round(size * .47)))
        brand_lines = wrap(brand_text, brand, brand_width)
        title_lines = wrap(product, title, width - 2)
        body_lines = wrap(description, body, width - 2)
        brand_step = sum(brand.getmetrics())
        title_step = sum(title.getmetrics())
        body_step = sum(body.getmetrics()) + 2
        header_height = max(40, len(brand_lines) * brand_step)
        content_height = header_height + 19 + title_step * len(title_lines) + 9 + body_step * len(body_lines)
        if footer_price:
            content_height += 48
        if content_height <= bottom - top:
            break

    y = top + (bottom - top - content_height) // 2
    brand_y = y + (header_height - len(brand_lines) * brand_step) // 2
    for line in brand_lines:
        brand_x = (left + right) / 2 if footer_price else left
        draw.text((brand_x, brand_y), line, font=brand, fill=style["accent"], anchor="ma" if footer_price else "la")
        brand_y += brand_step

    price_y = y + (header_height - 40) // 2
    price_x = right - price_width
    if side_price:
        price_x = 648 - price_width / 2
        price_y = (338 + 650 - 40) / 2
    elif footer_price:
        price_x = (left + right - price_width) / 2
        price_y = y + content_height - 40
    if not side_price:
        radius = 20 if centered else 7
        draw.rounded_rectangle((price_x, price_y, price_x + price_width, price_y + 40), radius=radius, fill=style["badge"])
    draw.text((price_x + price_width / 2, price_y + 20), price_text, font=price, fill=style["priceInk"], anchor="mm")
    y += header_height + 8
    if footer_price:
        draw.line((left + width / 2 - 25, y, left + width / 2 + 25, y), width=2, fill="#d38874")
    else:
        draw.line((left, y, right, y), width=1, fill=style["rule"])
    text_x = (left + right) / 2 if centered else left
    anchor = "ma" if centered else "la"
    y += 11
    for line in title_lines:
        draw.text((text_x, y), line, font=title, fill=style["ink"], anchor=anchor)
        y += title_step
    y += 9
    for line in body_lines:
        draw.text((text_x, y), line, font=body, fill=style["body"], anchor=anchor)
        y += body_step

    output = BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue()

