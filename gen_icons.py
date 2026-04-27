"""Generate extension icons (16, 48, 128px) using only stdlib — no PIL/cairo needed."""
import struct, zlib, math, os

# ── PNG encoder ──────────────────────────────────────────────────────────────

def png(w, h, pixels):
    """pixels: list of (r,g,b,a) length w*h, row-major."""
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    ihdr = chunk(b'IHDR', struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0]))
    raw = b''.join(
        b'\x00' + bytes(c for px in pixels[y*w:(y+1)*w] for c in px)
        for y in range(h)
    )
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend

# ── Drawing helpers ───────────────────────────────────────────────────────────

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))

def aa_alpha(dist, edge, feather=0.7):
    """1 inside, 0 outside, smooth at edge."""
    return clamp(1.0 - (dist - edge) / feather)

def blend(bg, fg, a):
    """Alpha-composite fg over bg, a in [0,1]."""
    return tuple(int(fg[i]*a + bg[i]*(1-a)) for i in range(3)) + (bg[3],)

# ── Icon drawing ──────────────────────────────────────────────────────────────

def make_icon(size):
    s = size
    pixels = [(0, 0, 0, 0)] * (s * s)

    GREEN  = (74, 148, 33, 255)   # Douban-ish green
    WHITE  = (255, 255, 255, 255)

    corner = s * 0.18  # rounded-rect corner radius

    # 1. Rounded-rectangle background
    for y in range(s):
        for x in range(s):
            dx = max(corner - x, 0, x - (s - 1 - corner))
            dy = max(corner - y, 0, y - (s - 1 - corner))
            d  = math.hypot(dx, dy)
            a  = aa_alpha(d, corner)
            if a > 0:
                r, g, b, _ = GREEN
                pixels[y*s+x] = (r, g, b, int(a * 255))

    # 2. Magnifying-glass: circle ring + handle
    cx = s * 0.42
    cy = s * 0.41
    outer_r  = s * 0.24
    stroke_w = s * 0.075
    ring_mid = outer_r - stroke_w / 2   # midline of the ring

    # Handle goes bottom-right at 135°
    angle    = math.radians(135)
    hx1 = cx + (outer_r - stroke_w) * math.cos(angle) * 0.9
    hy1 = cy + (outer_r - stroke_w) * math.sin(angle) * 0.9
    hx2 = hx1 + s * 0.24 * math.cos(angle)
    hy2 = hy1 + s * 0.24 * math.sin(angle)
    hw  = stroke_w                      # handle width same as stroke

    for y in range(s):
        for x in range(s):
            bg = pixels[y*s+x]
            if bg[3] == 0:
                continue
            fx, fy = x + 0.5, y + 0.5

            # Ring: distance to circle midline
            d_center = math.hypot(fx - cx, fy - cy)
            ring_a = aa_alpha(abs(d_center - ring_mid), stroke_w / 2)

            # Handle: distance to line segment
            segdx, segdy = hx2 - hx1, hy2 - hy1
            seg_len = math.hypot(segdx, segdy)
            if seg_len:
                t  = clamp(((fx-hx1)*segdx + (fy-hy1)*segdy) / seg_len**2, 0, 1)
                px = hx1 + t*segdx
                py = hy1 + t*segdy
                d_seg = math.hypot(fx - px, fy - py)
                handle_a = aa_alpha(d_seg, hw / 2)
            else:
                handle_a = 0.0

            a = max(ring_a, handle_a)
            if a > 0:
                pixels[y*s+x] = blend(bg, WHITE, a)

    return pixels

# ── Write files ───────────────────────────────────────────────────────────────

os.makedirs('extension/icons', exist_ok=True)
for size in (16, 48, 128):
    data = png(size, size, make_icon(size))
    path = f'extension/icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'wrote {path}  ({len(data)} bytes)')
