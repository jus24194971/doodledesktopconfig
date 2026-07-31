"""
Generate the application icon set from a single vector-ish description.

Run with `python build/make-icon.py`. Produces build/icon.ico (Windows),
build/icon.png (Linux) and build/icon.icns source art (macOS uses the 1024 png).

The mark is a rounded square carrying the app's accent-to-violet gradient, with a
four-node mesh drawn over it — a hub linked to three peers, which reads as a mesh
network rather than a generic wifi fan. Everything is drawn at 8x and downsampled
so the curves stay clean at 16px.
"""

from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Brand colours, matching styles.css.
ACCENT = (75, 159, 255)
VIOLET = (169, 139, 255)
INK = (13, 17, 23)

SS = 8  # supersampling factor
BASE = 256
S = BASE * SS


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def diagonal_gradient(size, c0, c1):
    """Top-left to bottom-right linear gradient."""
    g = Image.new("RGB", (size, size))
    px = g.load()
    # Build one row of the projection and reuse it — the gradient is constant along
    # the anti-diagonal, so this is exact, not an approximation.
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c0, c1, t)
    return g


def build_master():
    # Base plate with gradient, clipped to a rounded square.
    grad = diagonal_gradient(S, ACCENT, VIOLET)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), rounded_mask(S, radius=int(S * 0.22)))

    d = ImageDraw.Draw(icon)

    # Mesh geometry, in 0..1 space: one hub plus three peers.
    hub = (0.50, 0.53)
    peers = [(0.22, 0.30), (0.79, 0.31), (0.63, 0.81)]

    def pt(p):
        return (p[0] * S, p[1] * S)

    link_w = int(S * 0.038)
    hub_r = int(S * 0.105)
    peer_r = int(S * 0.072)

    # Links first so the nodes sit on top of them.
    for p in peers:
        d.line([pt(hub), pt(p)], fill=(255, 255, 255, 235), width=link_w)
    # One peer-to-peer link, so it reads as a mesh rather than a star.
    d.line([pt(peers[1]), pt(peers[2])], fill=(255, 255, 255, 150), width=int(link_w * 0.72))

    def dot(p, r, fill):
        cx, cy = pt(p)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    # Peers: solid white. Hub: white ring with the dark background showing through,
    # which keeps it distinguishable at 16px.
    for p in peers:
        dot(p, peer_r, (255, 255, 255, 255))
    dot(hub, hub_r, (255, 255, 255, 255))
    dot(hub, int(hub_r * 0.44), INK + (255,))

    return icon.resize((BASE, BASE), Image.LANCZOS)


def main():
    master = build_master()

    # A 1024px master for macOS / stores / readme use.
    big = build_master().resize((1024, 1024), Image.LANCZOS)
    big.save(os.path.join(HERE, "icon.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(
        os.path.join(HERE, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
    )
    print("wrote icon.ico ({}) and icon.png (1024)".format(", ".join(f"{s}x{s}" for s in sizes)))


if __name__ == "__main__":
    main()
